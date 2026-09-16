// ==UserScript==
// @name         自动答题
// @namespace    local.jyeoo.answer
// @version      1.2.1
// @description  在菁优考试页手动启动 AI 连续答题；不自动保存或交卷。
// @homepage     https://github.com/hhwsss/OpenSource/tree/main/userscripts
// @updateURL    https://raw.githubusercontent.com/hhwsss/OpenSource/main/userscripts/auto-answer.user.js
// @downloadURL  https://raw.githubusercontent.com/hhwsss/OpenSource/main/userscripts/auto-answer.user.js
// @match        https://is.jyeoo.com/User/Exam/Doing*
// @match        http://is.jyeoo.com/User/Exam/Doing*
// @run-at       document-idle
// @noframes
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api-inference.modelscope.cn
// ==/UserScript==

(() => {
  "use strict";
  const API_ROOT = "https://api-inference.modelscope.cn/v1";
  const DEFAULT_MODEL = "Qwen/Qwen3.8-Flash-Next";
  const TOKEN_KEY = "jyeooModelScopeToken";
  const MODEL_KEY = "jyeooModelScopeModel";
  const PANEL_ID = "jyeoo-gear-answer-helper";
  const PANEL_POSITION_KEY = "jyeooGearPanelPosition";
  
  class AuthenticationError extends Error {}
  class ModelUnavailableError extends Error {}
  
  // 规范化用户填写的魔搭 Key。
  function normalizeToken(value) {
    return String(value || "").trim().replace(/^Bearer\s+/iu, "").trim();
  }
  
  // 规范化页面文本中的空白。
  function cleanText(value) {
    return String(value || "").replace(/\s+/gu, " ").trim();
  }
  
  // 从模型输出中严格解析单个有效答案字母。
  function parseAnswerLetter(value, options) {
    let text = typeof value === "string" ? value.trim() : "";
    if (text.startsWith("{")) {
      try { text = String(JSON.parse(text).answer || "").trim(); }
      catch { return null; }
    }
    const match = text.match(/^(?:(?:正确答案|答案|answer|choice|option)\s*[:：]?\s*)?["'`（(]?([A-H])["'`）).。!！]?$/iu);
    const letter = match?.[1]?.toUpperCase();
    return options.some((option) => option.label === letter) ? letter : null;
  }
  
  // 读取页面中所有可处理的未答文本单选题。
  function extractQuestions(documentRef) {
    const questions = [];
    const skipped = [];
    const roots = Array.from(documentRef.querySelectorAll(".IS-EXAM-DOING-QUES"));
    const seen = new Set();
    for (const root of roots) {
      const number = Number(root.getAttribute("data-ix")) + 1;
      try {
        const question = extractQuestion(root);
        if (seen.has(question.id)) throw new Error("题目 ID 重复");
        seen.add(question.id);
        if (!root.querySelector("input:checked")) questions.push(question);
      } catch (error) {
        skipped.push({ number, reason: error.message });
      }
    }
    return { questions, skipped, total: roots.length };
  }
  
  // 从单个题目节点提取题干和选项。
  function extractQuestion(root) {
    const id = cleanText(root.getAttribute("data-id"));
    const index = cleanText(root.getAttribute("data-ix"));
    if (!id || !/^\d+$/u.test(index)) throw new Error("题目标识缺失");
    if (root.querySelector("img,svg,canvas,math,video,audio,input[type='checkbox']")) {
      throw new Error("图片、公式、多选或媒体题");
    }
    const heading = root.querySelector(".card-title,.ques-title,.question-title,h1,h2,h3,h4");
    const stem = cleanText(heading?.textContent).replace(/^\d+\s*[．.、]\s*/u, "");
    const options = Array.from(root.querySelectorAll("input[type='radio']")).map((input) => ({
      label: cleanText(input.getAttribute("data-seq") || input.value).toUpperCase(),
      text: cleanText(input.closest("label")?.textContent).replace(/^[A-H]\s*[．.、:：)）-]\s*/iu, ""),
      input
    }));
    if (!stem || options.length < 2 || options.some((option) => !/^[A-H]$/u.test(option.label) || !option.text)) {
      throw new Error("题干或选项不完整");
    }
    if (new Set(options.map((option) => option.label)).size !== options.length) throw new Error("选项重复");
    const fingerprint = JSON.stringify({ id, index, stem, options: options.map(({ label, text }) => ({ label, text })) });
    return { id, index, stem, options, fingerprint, root };
  }
  
  // 从最新模型目录筛选可能支持文本对话的模型。
  function selectModelCandidates(data, excluded = []) {
    if (!Array.isArray(data?.data)) throw new Error("模型列表格式异常");
    const excludedSet = new Set(excluded);
    const ids = data.data.map((item) => item?.id).filter((id) => typeof id === "string" && id.length < 200);
    const candidates = Array.from(new Set(ids)).filter((id) => !excludedSet.has(id) &&
      !/image|embedding|rerank|whisper|tts|\basr\b|diffusion|flux|\bwan[\d-]/iu.test(id));
    const score = (id) => id === DEFAULT_MODEL ? 0 : /flash|instruct/iu.test(id) ? 1 : /thinking|reasoner/iu.test(id) ? 3 : 2;
    return candidates.sort((left, right) => score(left) - score(right) || left.localeCompare(right)).slice(0, 100);
  }
  
  // 创建兼容现代和传统油猴接口的隔离存储。
  function createStorage(scope = globalThis) {
    const fallback = scope.localStorage;
    return {
      async get(key, defaultValue = "") {
        if (scope.GM?.getValue) return scope.GM.getValue(key, defaultValue);
        if (typeof scope.GM_getValue === "function") return scope.GM_getValue(key, defaultValue);
        return fallback?.getItem(key) ?? defaultValue;
      },
      async set(key, value) {
        if (scope.GM?.setValue) return scope.GM.setValue(key, value);
        if (typeof scope.GM_setValue === "function") return scope.GM_setValue(key, value);
        fallback?.setItem(key, String(value));
      },
      async remove(key) {
        if (scope.GM?.deleteValue) return scope.GM.deleteValue(key);
        if (typeof scope.GM_deleteValue === "function") return scope.GM_deleteValue(key);
        fallback?.removeItem(key);
      }
    };
  }
  
  // 创建优先使用 fetch、失败时回退油猴跨域请求的 HTTP 客户端。
  function createHttpClient(scope = globalThis) {
    return {
      async request(url, options) {
        try { return await requestByFetch(scope, url, options); }
        catch (error) {
          if (options.signal?.aborted) throw error;
          const request = scope.GM?.xmlHttpRequest || scope.GM_xmlhttpRequest;
          if (typeof request !== "function") throw error;
          return requestByUserscript(request, url, options);
        }
      }
    };
  }
  
  // 使用浏览器 fetch 发起带超时的 JSON 请求。
  async function requestByFetch(scope, url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 60_000);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await scope.fetch(url, {
        method: options.method || "GET",
        headers: createHeaders(options.token),
        body: options.body,
        signal: controller.signal
      });
      return createHttpResult(response.status, await response.text());
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  
  // 使用油猴 API 发起跨域 JSON 请求。
  function requestByUserscript(request, url, options) {
    return new Promise((resolve, reject) => {
      const handle = request({
        url, method: options.method || "GET", headers: createHeaders(options.token), data: options.body,
        timeout: options.timeoutMs || 60_000,
        onload: (response) => resolve(createHttpResult(response.status, response.responseText)),
        onerror: () => reject(new Error("网络请求失败")),
        ontimeout: () => reject(new Error("网络请求超时")),
        onabort: () => reject(new DOMException("请求已取消", "AbortError"))
      });
      options.signal?.addEventListener("abort", () => handle?.abort?.(), { once: true });
    });
  }
  
  // 创建请求头，Key 只发送给魔搭接口。
  function createHeaders(token) {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }
  
  // 解析 HTTP 文本并保留无法解析时的安全错误信息。
  function createHttpResult(status, text) {
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status, ok: status >= 200 && status < 300, data, text: String(text || "").slice(0, 500) };
  }
  
  // 创建连续答题控制器。
  function createAnswerRunner(dependencies) {
    const documentRef = dependencies.document;
    const locationRef = dependencies.location;
    const storage = dependencies.storage;
    const http = dependencies.http;
    const promptKey = dependencies.promptKey;
    const setStatus = dependencies.setStatus || (() => {});
    let running = false;
    let cancelled = false;
    let controller = null;
  
    return { run, cancel, resetKey, isRunning: () => running };
  
    // 启动一次完整答题流程。
    async function run() {
      if (running) return;
      verifyPage(documentRef, locationRef);
      running = true;
      cancelled = false;
      controller = new AbortController();
      try {
        const token = await getValidatedToken();
        let model = await findWorkingModel(token, await storage.get(MODEL_KEY, DEFAULT_MODEL), []);
        await storage.set(MODEL_KEY, model);
        const extracted = extractQuestions(documentRef);
        if (!extracted.questions.length) throw new Error("没有需要自动处理的文本单选题");
        const result = await answerQuestions(extracted, token, model);
        setStatus(`完成：勾选 ${result.completed} 题，跳过 ${extracted.skipped.length} 题。请检查后手动交卷。`, "success");
      } catch (error) {
        if (cancelled || error?.name === "AbortError") setStatus("已停止，已完成的选择会保留。", "warning");
        else setStatus(error.message || "运行失败", "error");
      } finally {
        running = false;
        controller = null;
        dependencies.onRunningChange?.(false);
      }
    }
  
    // 获取 Key 并验证至少一个可用模型，认证失败时清除旧配置。
    async function getValidatedToken() {
      let token = normalizeToken(await storage.get(TOKEN_KEY, ""));
      if (!token) token = normalizeToken(await promptKey("请输入魔搭 API Key："));
      if (!token || /\s/u.test(token) || /[^\x21-\x7e]/u.test(token)) throw new Error("Key 为空或格式不正确");
      try {
        await requestModels(token);
        await storage.set(TOKEN_KEY, token);
        return token;
      } catch (error) {
        if (error instanceof AuthenticationError) {
          await storage.remove(TOKEN_KEY);
          await storage.remove(MODEL_KEY);
        }
        throw error;
      }
    }
  
    // 从缓存模型开始探测，失败后刷新列表并逐个验证。
    async function findWorkingModel(token, preferredModel, excluded) {
      const first = cleanText(preferredModel) || DEFAULT_MODEL;
      setStatus(`正在验证模型：${first}`, "working");
      if (!excluded.includes(first) && await probeModel(token, first)) return first;
      const failed = new Set([...excluded, first]);
      const models = selectModelCandidates(await requestModels(token), [...failed]);
      for (let index = 0; index < models.length; index += 1) {
        ensureNotCancelled();
        setStatus(`正在检测模型 ${index + 1}/${models.length}：${models[index]}`, "working");
        if (await probeModel(token, models[index])) return models[index];
        failed.add(models[index]);
      }
      throw new Error(`已检测 ${failed.size} 个模型，未找到可用文本模型`);
    }
  
    // 获取最新模型目录并识别认证失败。
    async function requestModels(token) {
      const response = await http.request(`${API_ROOT}/models`, {
        method: "GET", token, signal: controller.signal, timeoutMs: 30_000
      });
      ensureAuthenticated(response);
      if (!response.ok || !Array.isArray(response.data?.data)) throw new Error("获取模型列表失败");
      return response.data;
    }
  
    // 使用固定简单题验证模型能否返回有效答案。
    async function probeModel(token, model) {
      const options = [{ label: "A", text: "2" }, { label: "B", text: "3" }];
      try {
        const response = await requestAnswer(token, model, "1 + 1 等于多少？", options);
        return response === "A";
      } catch (error) {
        if (error instanceof ModelUnavailableError) return false;
        throw error;
      }
    }
  
    // 逐题请求、选择并保存答案，模型失效时刷新后重试当前题。
    async function answerQuestions(extracted, token, initialModel) {
      let model = initialModel;
      const failedModels = new Set();
      let completed = 0;
      for (let index = 0; index < extracted.questions.length; index += 1) {
        ensureNotCancelled();
        const question = extracted.questions[index];
        if (question.root.querySelector("input:checked")) continue;
        setStatus(`答题中 ${index + 1}/${extracted.questions.length}，已完成 ${completed} 题`, "working");
        try {
          const answer = await requestAnswer(token, model, question.stem, question.options);
          if (!answer) throw new ModelUnavailableError("模型未返回有效答案");
          await applyAnswer(question, answer);
          completed += 1;
        } catch (error) {
          if (!(error instanceof ModelUnavailableError)) throw error;
          failedModels.add(model);
          model = await findWorkingModel(token, "", [...failedModels]);
          await storage.set(MODEL_KEY, model);
          index -= 1;
        }
      }
      return { completed, model };
    }
  
    // 请求指定模型回答一道题并解析答案。
    async function requestAnswer(token, model, stem, options) {
      const response = await http.request(`${API_ROOT}/chat/completions`, {
        method: "POST", token, body: createRequestBody(model, stem, options),
        signal: controller.signal, timeoutMs: 60_000
      });
      ensureAuthenticated(response);
      if (!response.ok) throw new ModelUnavailableError(response.data?.error?.message || `接口状态 ${response.status}`);
      return parseAnswerLetter(response.data?.choices?.[0]?.message?.content, options);
    }
  
    // 仅勾选答案，不切题、不触发网站草稿保存或交卷逻辑。
    async function applyAnswer(question, answer) {
      verifyQuestion(question);
      const input = question.options.find((option) => option.label === answer)?.input;
      if (!input || input.disabled) throw new Error("答案选项不可用");
      if (question.root.querySelector("input:checked")) return;
      input.click();
      if (!input.checked) throw new Error("选项未勾选成功");
    }
  
    // 检查请求期间题目是否变化，防止旧答案写入新题。
    function verifyQuestion(question) {
      const root = Array.from(documentRef.querySelectorAll(".IS-EXAM-DOING-QUES"))
        .find((item) => item.getAttribute("data-id") === question.id);
      if (!root || extractQuestion(root).fingerprint !== question.fingerprint) throw new Error("题目内容已变化，已停止");
    }
  
    // 识别 Key 失效并清除持久配置。
    function ensureAuthenticated(response) {
      const message = JSON.stringify(response.data?.error || "");
      if (response.status === 401 || /unauthori[sz]ed|invalid.*(?:token|key|credential)|(?:token|key).*(?:invalid|expired)/iu.test(message)) {
        throw new AuthenticationError("Key 无效或已过期，请点击“重置 Key”后重新填写");
      }
    }
  
    // 检查用户是否已经停止运行。
    function ensureNotCancelled() {
      if (cancelled) throw new DOMException("运行已停止", "AbortError");
    }
  
    // 停止当前运行并中断 fetch 请求。
    function cancel() {
      cancelled = true;
      controller?.abort();
      setStatus("正在停止…", "warning");
    }
  
    // 清除保存的 Key 和缓存模型。
    async function resetKey() {
      await storage.remove(TOKEN_KEY);
      await storage.remove(MODEL_KEY);
      setStatus("Key 和缓存模型已清除，下次运行会重新询问。", "success");
    }
  }
  
  // 创建 OpenAI Chat Completions 兼容请求正文。
  function createRequestBody(model, stem, options) {
    return JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是答题助手。只返回一个当前选项中存在的有效选项字母，不要解释。" },
        { role: "user", content: `${stem}\n${options.map((option) => `${option.label}. ${option.text}`).join("\n")}` }
      ],
      temperature: 0,
      max_tokens: 128,
      stream: false
    });
  }
  
  // 校验当前网页确实是菁优考试页面。
  function verifyPage(documentRef, locationRef) {
    const url = new URL(locationRef.href);
    if (url.hostname !== "is.jyeoo.com" || !/^\/User\/Exam\/Doing$/iu.test(url.pathname) ||
        !documentRef.querySelector(".IS-EXAM-DOING")) {
      throw new Error("请在菁优考试页面使用此脚本");
    }
  }
  
  // 创建可折叠、可拖动且适配安全区域的控制面板。
  function createPanel(documentRef, scope = globalThis) {
    documentRef.getElementById(PANEL_ID)?.remove();
    const host = documentRef.createElement("div");
    host.id = PANEL_ID;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host{all:initial;position:fixed;top:max(8px,env(safe-area-inset-top));right:max(8px,env(safe-area-inset-right));z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
        *{box-sizing:border-box}.shell{position:relative}.fab,.panel{box-shadow:0 8px 24px rgba(15,23,42,.22)}
        button{appearance:none;border:0;font:inherit;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
        button:focus-visible{outline:3px solid rgba(37,99,235,.38);outline-offset:2px}
        .fab{position:relative;width:48px;height:48px;border-radius:50%;background:#2563eb;color:#fff;font-size:14px;font-weight:800;letter-spacing:.02em;touch-action:none;cursor:grab}
        .fab::after{content:"";position:absolute;right:3px;bottom:3px;width:10px;height:10px;border:2px solid #fff;border-radius:50%;background:#64748b}
        .shell[data-state="working"] .fab::after{background:#f59e0b}.shell[data-state="success"] .fab::after{background:#16a34a}.shell[data-state="error"] .fab::after{background:#dc2626}
        .panel{width:min(252px,calc(100vw - 16px));overflow:hidden;border:1px solid #dbe3ef;border-radius:13px;background:rgba(255,255,255,.98);color:#172033}
        .header{min-height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 12px;background:#f1f5f9;touch-action:none;cursor:grab;user-select:none}
        .title{font-size:14px;font-weight:760}.collapse{width:44px;height:44px;border-radius:9px;background:transparent;color:#475569;display:grid;place-items:center}
        .collapse svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
        .body{padding:10px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.actions button{min-height:44px;border-radius:9px;padding:7px 8px;background:#e8eef8;color:#172033;font-size:13px;font-weight:680}
        .actions .primary{background:#2563eb;color:#fff}.actions .danger{grid-column:1/-1;background:#fee2e2;color:#991b1b}.actions button:active,.collapse:active,.fab:active{opacity:.72}.actions button:disabled{opacity:.42}
        .status{margin-top:8px;max-height:56px;overflow:auto;font-size:12px;line-height:1.45;word-break:break-word;color:#475569}.status[data-state="error"]{color:#b91c1c}.status[data-state="success"]{color:#15803d}.status[data-state="warning"]{color:#a16207}
        .shell[data-collapsed="true"] .panel{display:none}.shell[data-collapsed="false"] .fab{display:none}
        @media (prefers-color-scheme:dark){.panel{border-color:#334155;background:rgba(15,23,42,.97);color:#f8fafc}.header{background:#1e293b}.collapse,.status{color:#cbd5e1}.actions button{background:#334155;color:#f8fafc}.actions .danger{background:#4c1d1d;color:#fecaca}}
        @media (prefers-reduced-motion:no-preference){.fab,.panel{transition:opacity .18s ease,box-shadow .18s ease}}
      </style>
      <div class="shell" data-collapsed="true" data-state="idle">
        <button class="fab" data-action="toggle" aria-label="展开自动答题面板">AI</button>
        <section class="panel" aria-label="自动答题控制面板">
          <div class="header" data-drag-handle><span class="title">自动答题</span><button class="collapse" data-action="collapse" aria-label="收起面板"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button></div>
          <div class="body"><div class="actions"><button class="primary" data-action="start">开始</button><button data-action="stop" disabled>停止</button><button class="danger" data-action="reset">重置 Key</button></div><div class="status" data-state="idle" role="status" aria-live="polite">准备就绪；仅处理文本单选题，不会自动交卷。</div></div>
        </section>
      </div>`;
    documentRef.documentElement.append(host);
    const shell = shadow.querySelector(".shell");
    const toggle = shadow.querySelector("[data-action='toggle']");
    const collapse = shadow.querySelector("[data-action='collapse']");
    restorePanelPosition(host, scope);
    bindDrag(host, toggle, scope, () => setCollapsed(false));
    bindDrag(host, shadow.querySelector("[data-drag-handle]"), scope);
    collapse.addEventListener("click", () => setCollapsed(true));
    scope.addEventListener?.("resize", () => clampPanel(host, scope));
  
    // 切换折叠状态并重新约束浮层位置。
    function setCollapsed(collapsed) {
      shell.dataset.collapsed = String(collapsed);
      toggle.setAttribute("aria-label", collapsed ? "展开自动答题面板" : "收起自动答题面板");
      scope.requestAnimationFrame?.(() => clampPanel(host, scope));
    }
  
    return {
      host,
      shell,
      toggle,
      setCollapsed,
      start: shadow.querySelector("[data-action='start']"),
      stop: shadow.querySelector("[data-action='stop']"),
      reset: shadow.querySelector("[data-action='reset']"),
      status: shadow.querySelector(".status")
    };
  }
  
  // 为浮层绑定触摸笔、触摸屏和鼠标统一拖动行为。
  function bindDrag(host, handle, scope, onTap) {
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const rect = host.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || (drag.id !== undefined && event.pointerId !== undefined && drag.id !== event.pointerId)) return;
      const deltaX = event.clientX - drag.x;
      const deltaY = event.clientY - drag.y;
      if (Math.hypot(deltaX, deltaY) > 4) drag.moved = true;
      if (!drag.moved) return;
      event.preventDefault();
      setPanelPosition(host, drag.left + deltaX, drag.top + deltaY, scope);
    });
    const finish = (event) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      handle.releasePointerCapture?.(event.pointerId);
      if (!moved) onTap?.();
      else savePanelPosition(host, scope);
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", () => { drag = null; });
  }
  
  // 设置浮层位置并限制在当前可视区域内。
  function setPanelPosition(host, left, top, scope) {
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    clampPanel(host, scope);
  }
  
  // 避免浮层被拖到屏幕之外。
  function clampPanel(host, scope) {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const padding = 8;
    const left = Math.min(Math.max(rect.left, padding), Math.max(padding, scope.innerWidth - rect.width - padding));
    const top = Math.min(Math.max(rect.top, padding), Math.max(padding, scope.innerHeight - rect.height - padding));
    host.style.right = "auto";
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }
  
  // 保存非敏感的浮层坐标，便于下次保持位置。
  function savePanelPosition(host, scope) {
    try {
      const rect = host.getBoundingClientRect();
      scope.localStorage?.setItem(PANEL_POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch {}
  }
  
  // 恢复上次拖动位置；无记录时保持右上角默认位置。
  function restorePanelPosition(host, scope) {
    try {
      const position = JSON.parse(scope.localStorage?.getItem(PANEL_POSITION_KEY) || "null");
      if (Number.isFinite(position?.left) && Number.isFinite(position?.top)) {
        setPanelPosition(host, position.left, position.top, scope);
      }
    } catch {}
  }
  
  // 初始化 Gear 用户脚本和按钮事件。
  function initializeGearAnswerHelper(scope = globalThis) {
    if (!scope.document || !scope.location) return null;
    const panel = createPanel(scope.document, scope);
    const setStatus = (message, state = "idle") => {
      panel.status.textContent = message;
      panel.status.dataset.state = state;
      panel.shell.dataset.state = state;
    };
    const runner = createAnswerRunner({
      document: scope.document,
      location: scope.location,
      storage: createStorage(scope),
      http: createHttpClient(scope),
      promptKey: (message) => scope.prompt(message) || "",
      setStatus,
      onRunningChange: (running) => {
        panel.start.disabled = running;
        panel.stop.disabled = !running;
      }
    });
    panel.start.addEventListener("click", () => {
      panel.start.disabled = true;
      panel.stop.disabled = false;
      runner.run();
    });
    panel.stop.addEventListener("click", runner.cancel);
    panel.reset.addEventListener("click", async () => {
      if (scope.confirm("确定清除已保存的 Key 和模型吗？")) await runner.resetKey();
    });
    registerDesktopControls(scope, runner, panel, setStatus);
    return runner;
  }
  
  // 注册电脑键盘、用户脚本菜单和页面右键菜单入口。
  function registerDesktopControls(scope, runner, panel, setStatus = () => {}) {
    const start = () => {
      if (runner.isRunning()) {
        setStatus("答题任务正在运行。", "warning");
        return;
      }
      panel.start.disabled = true;
      panel.stop.disabled = false;
      panel.setCollapsed(false);
      runner.run();
    };
    const reset = async () => {
      if (scope.confirm("确定清除已保存的 Key 和模型吗？")) await runner.resetKey();
    };
    scope.document.addEventListener("keydown", (event) => {
      if (!isAnswerShortcut(event) || isEditableTarget(event.target)) return;
      event.preventDefault();
      start();
    }, true);
    registerUserscriptCommand(scope, "开始自动答题（Ctrl+Q）", start);
    registerUserscriptCommand(scope, "停止自动答题", runner.cancel);
    registerUserscriptCommand(scope, "重置自动答题 Key", reset);
    if (scope.matchMedia?.("(pointer: fine)")?.matches) {
      createDesktopContextMenu(scope, { start, stop: runner.cancel, toggle: () => panel.setCollapsed(panel.shell.dataset.collapsed !== "true"), reset });
    }
  }
  
  // 判断键盘事件是否为 Ctrl+Q，避免占用 Command+Q 等系统快捷键。
  function isAnswerShortcut(event) {
    return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key?.toLowerCase() === "q";
  }
  
  // 避免用户在输入、选择或编辑文字时误触答题快捷键。
  function isEditableTarget(target) {
    return typeof target?.closest === "function" && Boolean(target.closest("input,textarea,select,[contenteditable='true']"));
  }
  
  // 兼容现代和传统用户脚本菜单注册接口。
  function registerUserscriptCommand(scope, name, callback) {
    const command = scope.GM?.registerMenuCommand || scope.GM_registerMenuCommand;
    if (typeof command === "function") command(name, callback);
  }
  
  // 创建仅在桌面精确指针设备启用的页面右键菜单。
  function createDesktopContextMenu(scope, actions) {
    const host = scope.document.createElement("div");
    host.id = `${PANEL_ID}-context-menu`;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        .menu{position:fixed;width:190px;padding:6px;border:1px solid #dbe3ef;border-radius:10px;background:#fff;box-shadow:0 10px 28px rgba(15,23,42,.24);pointer-events:auto}
        .menu[hidden]{display:none}.menu button{width:100%;min-height:34px;padding:6px 10px;border:0;border-radius:7px;background:transparent;color:#172033;text-align:left;font:500 13px/1.35 inherit}
        .menu button:hover,.menu button:focus-visible{background:#e8eef8;outline:none}.menu .danger{color:#b91c1c}
        @media (prefers-color-scheme:dark){.menu{border-color:#334155;background:#0f172a}.menu button{color:#f8fafc}.menu button:hover,.menu button:focus-visible{background:#334155}.menu .danger{color:#fca5a5}}
      </style>
      <div class="menu" role="menu" hidden>
        <button role="menuitem" data-action="start">开始自动答题　Ctrl+Q</button>
        <button role="menuitem" data-action="stop">停止自动答题</button>
        <button role="menuitem" data-action="toggle">展开/收起面板</button>
        <button role="menuitem" class="danger" data-action="reset">重置 Key</button>
      </div>`;
    scope.document.documentElement.append(host);
    const menu = shadow.querySelector(".menu");
    for (const [name, callback] of Object.entries(actions)) {
      shadow.querySelector(`[data-action='${name}']`).addEventListener("click", () => {
        hide();
        callback();
      });
    }
    scope.document.addEventListener("contextmenu", (event) => {
      if (isNativeContextTarget(event.target)) return;
      event.preventDefault();
      const left = Math.min(event.clientX, Math.max(8, scope.innerWidth - 198));
      const top = Math.min(event.clientY, Math.max(8, scope.innerHeight - 158));
      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${Math.max(8, top)}px`;
      menu.hidden = false;
      shadow.querySelector("[data-action='start']").focus();
    });
    scope.document.addEventListener("click", hide, true);
    scope.document.addEventListener("scroll", hide, true);
    scope.document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); }, true);
  
    // 隐藏右键菜单并交还页面交互。
    function hide() {
      menu.hidden = true;
    }
    return host;
  }
  
  // 在需要复制、输入或打开链接的位置保留浏览器原生右键菜单。
  function isNativeContextTarget(target) {
    return typeof target?.closest === "function" && Boolean(target.closest("input,textarea,select,a,[contenteditable='true']"));
  }
  
  initializeGearAnswerHelper(globalThis);
})();
