// Tokenweaver — счётчик контекста с разделением основного ответа и боковых запросов.
// Основа: ST Context Counter (niemandswasser, KiskaSora), Apache 2.0.

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "tokenweaver";
const LEGACY_SETTINGS_KEY = "st-context-counter";
const LOG = "[Tokenweaver]";

// Сбрасывать табло в 0 при смене чата (число от прошлого чата в новом только врёт).
const RESET_ON_CHAT_CHANGED = true;

// Насколько глубоко смотреть стек вызова, чтобы понять, кто отправил запрос.
const STACK_LIMIT = 60;

// Сдвиг в пикселях, после которого нажатие на табло считается перетаскиванием, а не кликом.
const DRAG_THRESHOLD = 5;

// Сколько символов текста показывать в превью сообщения.
const PREVIEW_LENGTH = 80;

// Подписи ролей в развёрнутом запросе.
const ROLE_LABELS = {
    system: "система",
    user: "юзер",
    assistant: "модель",
    tool: "инструмент",
    prompt: "промт",
};

// Подписи встроенных инъекций таверны в разбивке.
const BUILTIN_EXTENSION_LABELS = {
    "1_memory": "Сводка",
    "2_floating_prompt": "Заметка автора",
    "3_vectors": "Векторы чата",
    "4_vectors_data_bank": "Векторы банка данных",
    "chromadb": "Smart Context",
};

// Блоки Prompt Manager, которые относятся к карточке и лорбуку. Всё остальное — пресет.
const CARD_PROMPT_IDS = ["charDescription", "charPersonality", "scenario", "personaDescription", "dialogueExamples"];
const LORE_PROMPT_IDS = ["worldInfoBefore", "worldInfoAfter"];
const HISTORY_PROMPT_ID = "chatHistory";

// Позиции инъекций (extension_prompt_types в таверне).
const EXT_POSITION = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };

const MAIN_SOURCE_LABEL = "Основной ответ";
const UNKNOWN_SOURCE_LABEL = "Неизвестно";

// Наша собственная папка относительно /scripts/extensions/ (например, "third-party/Tokenweaver").
const OWN_PATH = decodeURIComponent(
    new URL(".", import.meta.url).pathname.replace(/^.*\/scripts\/extensions\//, "").replace(/\/$/, ""),
);

let contextIndicator = null;
let messageStats = { hidden: 0, total: 0 };
let chatObserver = null;
let documentTouchHandlersBound = false;

// --- Состояние счётчика ---
let lastMainTokens = 0;          // размер последнего основного запроса
let sideTokensSinceMain = 0;     // сумма боковых запросов после последнего основного
let mainEpoch = 0;               // растёт при каждом новом основном запросе / смене чата
let mainGenerationActive = false; // запасной признак: таверна начала основную генерацию
let lastStartedType = null;      // тип последней начатой генерации (normal, swipe, quiet...)

// --- История запросов (только в памяти) ---
let requestHistory = [];         // новые в начале
let entryCounter = 0;
const expandedEntries = new Set();
const extensionLabelCache = new Map(); // путь папки -> Promise<string>

// --- Разбивка последнего основного запроса ---
let lastBreakdown = null; // { epoch, status: "counting" | "ready" | "unsupported", total, lines, other, messagesInContext }

// --- Модули таверны, которые грузим динамически (если их нет — работаем без них) ---
let stTokenizers = null;
let stOpenAI = null;

// --- Окно ---
let panel = null;
let panelOpen = false;
let activeTab = "breakdown";

const defaultSettings = {
    enabled: true,
    position: "top-right",
    opacity: 1.0,
    scale: 1.0,
    bgColor: "#000000",
    bgOpacity: 0.85,
    borderRadius: 4,
    useFixedTextColor: false,
    textColor: "#ffffff",
    textOpacity: 1.0,
    useCustomMax: false,
    customMax: 32000,
    showMax: true,
    showSideOnIndicator: true,
    historySize: 5,
    excludedSources: [], // [{ path: "third-party/Frameweaver", label: "Frameweaver" }]
    showHiddenCounter: true,
    hiddenCounterPosition: "below",
    freePosition: null,
};

const POSITION_CLASSES = "tkw-pos-top-right tkw-pos-top-left tkw-pos-bottom-right tkw-pos-bottom-left";
const TEXT_CLASSES = "tkw-text-low tkw-text-medium tkw-text-high tkw-text-critical";

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function clampHistorySize(value) {
    const n = parseInt(value);
    if (!Number.isFinite(n)) return defaultSettings.historySize;
    return Math.min(20, Math.max(1, n));
}

// =====================================================================
// Настройки
// =====================================================================

async function loadSettings() {
    if (!extension_settings[extensionName]) {
        // Первый запуск: забираем оформление табло из старого Context Counter, если оно есть.
        const legacy = extension_settings[LEGACY_SETTINGS_KEY];
        extension_settings[extensionName] = legacy ? structuredClone(legacy) : {};
        saveSettingsDebounced();
    }

    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = structuredClone(defaultSettings[key]);
        }
    }

    const settings = extension_settings[extensionName];
    settings.historySize = clampHistorySize(settings.historySize);
    if (!Array.isArray(settings.excludedSources)) settings.excludedSources = [];

    $("#tkw_enabled").prop("checked", settings.enabled);
    $("#tkw_position").val(settings.position);
    $("#tkw_opacity").val(settings.opacity);
    $("#tkw_scale").val(settings.scale);
    $("#tkw_bg_color").val(settings.bgColor);
    $("#tkw_bg_opacity").val(settings.bgOpacity);
    $("#tkw_border_radius").val(settings.borderRadius);
    $("#tkw_use_fixed_text_color").prop("checked", settings.useFixedTextColor);
    $("#tkw_text_color").val(settings.textColor);
    $("#tkw_text_opacity").val(settings.textOpacity);
    $("#tkw_use_custom_max").prop("checked", settings.useCustomMax);
    $("#tkw_custom_max").val(settings.customMax);
    $("#tkw_show_max").prop("checked", settings.showMax);
    $("#tkw_show_side").prop("checked", settings.showSideOnIndicator);
    $("#tkw_history_size").val(settings.historySize);
    $("#tkw_show_hidden").prop("checked", settings.showHiddenCounter);
    $("#tkw_hidden_position").val(settings.hiddenCounterPosition);

    $("#tkw_opacity_value").text(Math.round(settings.opacity * 100) + "%");
    $("#tkw_bg_opacity_value").text(Math.round(settings.bgOpacity * 100) + "%");
    $("#tkw_text_opacity_value").text(Math.round(settings.textOpacity * 100) + "%");
    $("#tkw_border_radius_value").text(settings.borderRadius + "px");
    $("#tkw_scale_value").text(Number(settings.scale).toFixed(1) + "x");

    toggleCustomMaxField();
    toggleFixedTextColor();
    renderExcludedList();
}

function toggleCustomMaxField() {
    $("#tkw_custom_max_container").toggle(!!extension_settings[extensionName].useCustomMax);
}

function toggleFixedTextColor() {
    $("#tkw_fixed_text_color_container").toggle(!!extension_settings[extensionName].useFixedTextColor);
}

function updateSetting(key, value) {
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();

    if (key === "useCustomMax") {
        toggleCustomMaxField();
        updateContextDisplay();
    } else if (key === "useFixedTextColor") {
        toggleFixedTextColor();
        updateContextDisplay();
    } else if (key === "historySize") {
        trimHistory();
        renderPanel();
    } else if (["customMax", "showMax", "showSideOnIndicator", "showHiddenCounter", "textColor", "textOpacity"].includes(key)) {
        updateContextDisplay();
    } else if (key === "hiddenCounterPosition") {
        applyStyles();
        updateContextDisplay();
    } else {
        applyStyles();
        positionPanel();
    }
}

// =====================================================================
// Скрытые сообщения (как в исходнике)
// =====================================================================

function countMessages() {
    try {
        const chat = getContext()?.chat;
        if (!chat || chat.length === 0) return { hidden: 0, total: 0 };
        return {
            hidden: chat.filter(msg => msg.is_system === true).length,
            total: chat.length,
        };
    } catch (error) {
        console.error(LOG, "Error counting messages:", error);
        return { hidden: 0, total: 0 };
    }
}

function startChatObserver() {
    if (chatObserver) chatObserver.disconnect();

    const chatBlock = document.getElementById("chat");
    if (!chatBlock) return;

    chatObserver = new MutationObserver((mutations) => {
        let shouldUpdate = false;
        for (const mutation of mutations) {
            if (mutation.type === "childList" ||
                mutation.type === "attributes" ||
                mutation.target.classList?.contains("mes")) {
                shouldUpdate = true;
                break;
            }
        }
        if (shouldUpdate) {
            const newStats = countMessages();
            if (newStats.hidden !== messageStats.hidden || newStats.total !== messageStats.total) {
                updateContextDisplay();
            }
        }
    });

    chatObserver.observe(chatBlock, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "hidden", "style"],
    });
}

// =====================================================================
// Табло: перетаскивание и клик
// =====================================================================

function makeInteractive() {
    if (!contextIndicator) return;

    let pressed = false;
    let dragging = false;
    let startClientX = 0, startClientY = 0, startElemTop = 0, startElemLeft = 0;

    function press(clientX, clientY) {
        pressed = true;
        dragging = false;
        startClientX = clientX;
        startClientY = clientY;
    }

    function beginDrag() {
        const rect = contextIndicator[0].getBoundingClientRect();
        contextIndicator.removeClass(POSITION_CLASSES);
        startElemTop = rect.top;
        startElemLeft = rect.left;
        contextIndicator.css({
            top: startElemTop + "px",
            left: startElemLeft + "px",
            right: "auto",
            bottom: "auto",
            "transform-origin": "top left",
        });
        dragging = true;
        contextIndicator.addClass("tkw-is-dragging");
    }

    function move(clientX, clientY) {
        if (!pressed || !contextIndicator) return;
        if (!dragging) {
            const distance = Math.hypot(clientX - startClientX, clientY - startClientY);
            if (distance < DRAG_THRESHOLD) return;
            beginDrag();
        }
        const scale = extension_settings[extensionName].scale || 1;
        const newTop = startElemTop + (clientY - startClientY) / scale;
        const newLeft = startElemLeft + (clientX - startClientX) / scale;
        contextIndicator.css({ top: newTop + "px", left: newLeft + "px" });
        positionPanel();
    }

    function release() {
        if (!pressed || !contextIndicator) return;
        pressed = false;
        if (dragging) {
            dragging = false;
            contextIndicator.removeClass("tkw-is-dragging");
            const rect = contextIndicator[0].getBoundingClientRect();
            extension_settings[extensionName].freePosition = { x: rect.left, y: rect.top };
            saveSettingsDebounced();
            positionPanel();
        } else {
            togglePanel();
        }
    }

    contextIndicator.on("mousedown.tkw-drag", function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        press(e.clientX, e.clientY);
    });

    contextIndicator[0].addEventListener("touchstart", function (e) {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        press(touch.clientX, touch.clientY);
    }, { passive: false });

    // Обработчики на document — пересоздаём вместе с табло, чтобы они смотрели на актуальное.
    $(document).off(".tkw-drag");
    $(document).on("mousemove.tkw-drag", (e) => move(e.clientX, e.clientY));
    $(document).on("mouseup.tkw-drag", () => release());

    window.__tkwPointer = { move, release, isPressed: () => pressed, isDragging: () => dragging };
    if (!documentTouchHandlersBound) {
        documentTouchHandlersBound = true;
        document.addEventListener("touchmove", function (e) {
            const p = window.__tkwPointer;
            if (!p || !p.isPressed() || e.touches.length !== 1) return;
            if (p.isDragging()) e.preventDefault();
            const touch = e.touches[0];
            p.move(touch.clientX, touch.clientY);
        }, { passive: false });
        document.addEventListener("touchend", function () {
            window.__tkwPointer?.release();
        });
    }
}

function createIndicator() {
    removeIndicator();
    contextIndicator = $('<div id="tkw-indicator">0/0</div>');
    applyStyles();
    $("body").append(contextIndicator);
    makeInteractive();
    updateContextDisplay();
}

function removeIndicator() {
    if (contextIndicator) {
        $(document).off(".tkw-drag");
        contextIndicator.off(".tkw-drag");
        contextIndicator.remove();
        contextIndicator = null;
    }
    closePanel();
}

function applyStyles() {
    if (!contextIndicator) return;
    const settings = extension_settings[extensionName];

    const bgRgba = hexToRgba(settings.bgColor || "#000000", settings.bgOpacity !== undefined ? settings.bgOpacity : 0.85);
    contextIndicator.css({
        "opacity": settings.opacity,
        "transform": `scale(${settings.scale})`,
        "background-color": bgRgba,
        "border-radius": (settings.borderRadius !== undefined ? settings.borderRadius : 4) + "px",
        "white-space": settings.hiddenCounterPosition === "below" ? "pre-line" : "nowrap",
    });

    contextIndicator.removeClass(POSITION_CLASSES);
    if (settings.freePosition) {
        contextIndicator.css({
            "top": settings.freePosition.y + "px",
            "left": settings.freePosition.x + "px",
            "right": "auto",
            "bottom": "auto",
            "transform-origin": "top left",
        });
    } else {
        contextIndicator.css({
            "top": "", "left": "", "right": "", "bottom": "",
            "transform-origin": settings.position.includes("bottom")
                ? (settings.position.includes("right") ? "bottom right" : "bottom left")
                : (settings.position.includes("right") ? "top right" : "top left"),
        });
        contextIndicator.addClass(`tkw-pos-${settings.position}`);
    }
}

function getMaxTokens() {
    const settings = extension_settings[extensionName];
    if (settings.useCustomMax) return settings.customMax || 32000;
    return getContext()?.maxContext || 0;
}

function updateContextDisplay() {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled || !contextIndicator) return;

    const context = getContext();
    if (!context) return;

    const usedTokens = lastMainTokens;
    const maxTokens = getMaxTokens();

    messageStats = countMessages();

    // 52354/80000 + 3120 | 👻 121/151
    let displayHtml = settings.showMax ? `${usedTokens}/${maxTokens}` : `${usedTokens}`;

    if (settings.showSideOnIndicator && sideTokensSinceMain > 0) {
        displayHtml += ` <span class="tkw-side">+ ${sideTokensSinceMain}</span>`;
    }

    if (settings.showHiddenCounter && messageStats.total > 0) {
        const ghostIcon = '<i class="fa-solid fa-ghost"></i>';
        const hiddenPart = `${ghostIcon} ${messageStats.hidden}/${messageStats.total}`;
        if (settings.hiddenCounterPosition === "inline") {
            displayHtml += ` | ${hiddenPart}`;
        } else if (settings.hiddenCounterPosition === "below") {
            displayHtml += `<br>${hiddenPart}`;
        } else {
            displayHtml += ` (${hiddenPart})`;
        }
    }

    contextIndicator.html(displayHtml);

    // Цвет — только по основному запросу.
    const percentage = maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0;
    const textAlpha = settings.textOpacity !== undefined ? settings.textOpacity : 1.0;

    contextIndicator.removeClass(TEXT_CLASSES);

    if (settings.useFixedTextColor && settings.textColor) {
        contextIndicator.css("color", hexToRgba(settings.textColor, textAlpha));
    } else {
        let r, g, b;
        if (percentage < 50)      { r = 78;  g = 255; b = 78;  contextIndicator.addClass("tkw-text-low"); }
        else if (percentage < 75) { r = 255; g = 215; b = 0;   contextIndicator.addClass("tkw-text-medium"); }
        else if (percentage < 90) { r = 255; g = 140; b = 0;   contextIndicator.addClass("tkw-text-high"); }
        else                      { r = 255; g = 68;  b = 68;  contextIndicator.addClass("tkw-text-critical"); }
        contextIndicator.css("color", `rgba(${r},${g},${b},${textAlpha})`);
    }
}

// =====================================================================
// Окно «Контекст»
// =====================================================================

function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
}

function openPanel() {
    if (!contextIndicator) return;
    if (!panel) {
        panel = $(`
            <div id="tkw-panel">
                <div class="tkw-panel-header">
                    <span class="tkw-panel-title">Контекст</span>
                    <div class="tkw-panel-close fa-solid fa-xmark" title="Закрыть"></div>
                </div>
                <div class="tkw-tabs">
                    <div class="tkw-tab" data-tab="breakdown">Разбивка</div>
                    <div class="tkw-tab" data-tab="history">История</div>
                </div>
                <div class="tkw-panel-body"></div>
            </div>
        `);
        panel.on("click", ".tkw-panel-close", closePanel);
        panel.on("click", ".tkw-tab", function () {
            activeTab = String($(this).data("tab"));
            panel.find(".tkw-panel-body").scrollTop(0);
            renderPanel();
        });
        panel.on("click", ".tkw-row-exclude", function (e) {
            e.stopPropagation();
            const id = Number($(this).closest(".tkw-row").data("id"));
            const entry = requestHistory.find(item => item.id === id);
            if (entry?.sourcePath) excludeSource(entry.sourcePath, entry.sourceLabel);
        });
        panel.on("click", ".tkw-row-head", function () {
            const id = Number($(this).closest(".tkw-row").data("id"));
            toggleEntry(id);
        });
        $("body").append(panel);
    }
    panelOpen = true;
    panel.addClass("tkw-open");
    renderPanel();
    positionPanel();
}

function closePanel() {
    panelOpen = false;
    if (panel) panel.removeClass("tkw-open");
}

// Ставим окно рядом с табло: под ним, если хватает места, иначе над ним.
function positionPanel() {
    if (!panelOpen || !panel || !contextIndicator) return;

    const rect = contextIndicator[0].getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const margin = 10;
    const gap = 8;
    const width = Math.min(440, viewportW - margin * 2);

    let left = (rect.left + rect.width / 2 > viewportW / 2) ? rect.right - width : rect.left;
    left = Math.max(margin, Math.min(left, viewportW - width - margin));

    const spaceBelow = viewportH - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;

    const css = { width: width + "px", left: left + "px", right: "auto" };
    if (spaceBelow >= 220 || spaceBelow >= spaceAbove) {
        css.top = (rect.bottom + gap) + "px";
        css.bottom = "auto";
        css["max-height"] = Math.max(120, spaceBelow) + "px";
    } else {
        css.top = "auto";
        css.bottom = (viewportH - rect.top + gap) + "px";
        css["max-height"] = Math.max(120, spaceAbove) + "px";
    }
    panel.css(css);
}

function formatTime(date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function makePreview(text) {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    if (!flat) return "(без текста)";
    return flat.length > PREVIEW_LENGTH ? flat.slice(0, PREVIEW_LENGTH) + "…" : flat;
}

function renderEntryDetails(entry) {
    const rows = entry.messages.map((message, index) => {
        const role = ROLE_LABELS[message.role] || message.role || "?";
        const tokens = message.tokens === null ? "…" : message.tokens;
        return `
            <div class="tkw-msg">
                <span class="tkw-msg-role" title="${escapeHtml(message.role)}">${escapeHtml(role)}</span>
                <span class="tkw-msg-tokens" data-entry="${entry.id}" data-msg="${index}">${tokens}</span>
                <span class="tkw-msg-preview">${escapeHtml(makePreview(message.text))}</span>
            </div>`;
    }).join("");

    return `
        <div class="tkw-row-details">
            <div class="tkw-row-chat">Чат: ${escapeHtml(entry.chatName || "—")}</div>
            ${rows || '<div class="tkw-msg-empty">(сообщений нет)</div>'}
        </div>`;
}

function renderPanel() {
    if (!panelOpen || !panel) return;
    panel.find(".tkw-tab").each(function () {
        $(this).toggleClass("tkw-tab-active", $(this).data("tab") === activeTab);
    });

    const body = panel.find(".tkw-panel-body");
    const scrollTop = body.scrollTop();

    if (activeTab === "breakdown") renderBreakdown(body);
    else renderHistory(body);

    body.scrollTop(scrollTop);
}

function renderBreakdown(body) {
    const max = getMaxTokens();

    if (!lastBreakdown) {
        body.html('<div class="tkw-empty">Основного запроса пока не было — сгенерируй что-нибудь</div>');
        return;
    }

    if (lastBreakdown.status === "counting") {
        body.html('<div class="tkw-empty">Считаю…</div>');
        return;
    }

    const totalLine = `
        <div class="tkw-bd-total">
            <span>Всего</span>
            <span class="tkw-bd-tokens">${lastBreakdown.total} / ${max}</span>
        </div>`;

    if (lastBreakdown.status === "unsupported") {
        body.html(totalLine + '<div class="tkw-empty">Разбивка доступна только для Chat Completion</div>');
        return;
    }

    const lines = lastBreakdown.lines.map(line => `
        <div class="tkw-bd-line ${line.kind === "extension" ? "tkw-bd-ext" : ""}">
            <span class="tkw-bd-label">
                ${escapeHtml(line.label)}
                ${line.note ? `<span class="tkw-bd-note">${escapeHtml(line.note)}</span>` : ""}
            </span>
            <span class="tkw-bd-tokens">${line.tokens}</span>
        </div>`).join("");

    const other = lastBreakdown.other > 0 ? `
        <div class="tkw-bd-line tkw-bd-other">
            <span class="tkw-bd-label">Прочее</span>
            <span class="tkw-bd-tokens">${lastBreakdown.other}</span>
        </div>` : "";

    body.html(totalLine + lines + other);
}

function renderHistory(body) {
    if (requestHistory.length === 0) {
        body.html('<div class="tkw-empty">Запросов пока не было — сгенерируй что-нибудь</div>');
        return;
    }

    const html = requestHistory.map(entry => {
        const expanded = expandedEntries.has(entry.id);
        const tokens = entry.totalTokens === null ? "…" : entry.totalTokens;
        return `
            <div class="tkw-row ${entry.isMain ? "tkw-row-main" : ""} ${expanded ? "tkw-row-expanded" : ""}" data-id="${entry.id}">
                <div class="tkw-row-head" title="Чат: ${escapeHtml(entry.chatName || "—")}">
                    <span class="tkw-row-chevron fa-solid ${expanded ? "fa-chevron-down" : "fa-chevron-right"}"></span>
                    <span class="tkw-row-time">${formatTime(entry.time)}</span>
                    <span class="tkw-row-source">${escapeHtml(entry.sourceLabel)}</span>
                    <span class="tkw-row-model" title="${escapeHtml(entry.model)}">${escapeHtml(entry.model || "—")}</span>
                    <span class="tkw-row-tokens">${tokens}</span>
                    ${entry.sourcePath ? '<span class="tkw-row-exclude fa-solid fa-eye-slash" title="Не отслеживать это расширение"></span>' : '<span class="tkw-row-exclude-spacer"></span>'}
                </div>
                ${expanded ? renderEntryDetails(entry) : ""}
            </div>`;
    }).join("");

    body.html(html);
}

function toggleEntry(id) {
    if (expandedEntries.has(id)) {
        expandedEntries.delete(id);
    } else {
        expandedEntries.add(id);
        const entry = requestHistory.find(e => e.id === id);
        if (entry) countEntryMessages(entry);
    }
    renderPanel();
}

// Токены по каждому сообщению считаем только когда запрос развернули — и только один раз.
async function countEntryMessages(entry) {
    if (entry.messagesCounting || entry.messagesCounted) return;
    entry.messagesCounting = true;
    try {
        for (let i = 0; i < entry.messages.length; i++) {
            const message = entry.messages[i];
            if (message.tokens !== null) continue;
            message.tokens = message.text ? await countTokens(message.text) : 0;
            if (panel) panel.find(`.tkw-msg-tokens[data-entry="${entry.id}"][data-msg="${i}"]`).text(message.tokens);
        }
        entry.messagesCounted = true;
    } catch (e) {
        console.error(LOG, "Per-message token count failed:", e);
    } finally {
        entry.messagesCounting = false;
    }
}

// =====================================================================
// Фильтр «Не отслеживать»
// =====================================================================

function isExcluded(path) {
    if (!path) return false;
    return extension_settings[extensionName].excludedSources.some(item => item.path === path);
}

function excludeSource(path, label) {
    const settings = extension_settings[extensionName];
    if (!isExcluded(path)) {
        settings.excludedSources.push({ path, label: label || path.split("/").pop() });
        saveSettingsDebounced();
    }

    // Убираем его записи из истории прямо сейчас.
    requestHistory = requestHistory.filter(entry => {
        if (entry.sourcePath !== path) return true;
        expandedEntries.delete(entry.id);
        return false;
    });

    renderPanel();
    renderExcludedList();
    toastr.info(`${label || path} больше не отслеживается. Вернуть можно в настройках Tokenweaver`);
}

function restoreSource(path) {
    const settings = extension_settings[extensionName];
    settings.excludedSources = settings.excludedSources.filter(item => item.path !== path);
    saveSettingsDebounced();
    renderExcludedList();
}

function renderExcludedList() {
    const container = $("#tkw_excluded_list");
    if (!container.length) return;

    const list = extension_settings[extensionName].excludedSources;
    if (!list.length) {
        container.html('<div class="tkw-excluded-empty">Пока никого. Скрыть расширение можно иконкой глаза в окне истории.</div>');
        return;
    }

    container.html(list.map(item => `
        <div class="tkw-excluded-item">
            <span class="tkw-excluded-name" title="${escapeHtml(item.path)}">${escapeHtml(item.label)}</span>
            <div class="menu_button tkw-restore" data-path="${escapeHtml(item.path)}">Вернуть</div>
        </div>`).join(""));
}

// =====================================================================
// История запросов
// =====================================================================

function trimHistory() {
    const size = clampHistorySize(extension_settings[extensionName].historySize);
    if (requestHistory.length > size) {
        for (const removed of requestHistory.slice(size)) expandedEntries.delete(removed.id);
        requestHistory = requestHistory.slice(0, size);
    }
}

function currentChatName() {
    try {
        const context = getContext();
        if (typeof context?.getCurrentChatId === "function") return context.getCurrentChatId() || "";
        return context?.chatId || "";
    } catch {
        return "";
    }
}

// Человеческое имя расширения из его manifest.json, с кэшем.
function getExtensionLabel(path) {
    if (!extensionLabelCache.has(path)) {
        const fallback = path.split("/").pop();
        const promise = fetch(`/scripts/extensions/${path}/manifest.json`)
            .then(response => (response.ok ? response.json() : null))
            .then(manifest => (manifest?.display_name ? String(manifest.display_name) : fallback))
            .catch(() => fallback);
        extensionLabelCache.set(path, promise);
    }
    return extensionLabelCache.get(path);
}

function addHistoryEntry(entry) {
    requestHistory.unshift(entry);
    trimHistory();
    renderPanel();
}

// =====================================================================
// Перехват запросов: основной ответ vs боковые
// =====================================================================

function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    return "";
}

function isGenerationUrl(url) {
    return url.includes("/generate") || url.includes("/chat/completions");
}

// Текст одного сообщения: строка или массив частей (берём только текстовые, картинки пропускаем).
function messageText(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === "string") return part;
                if (typeof part?.text === "string") return part.text;
                return "";
            })
            .filter(Boolean)
            .join("\n");
    }
    return "";
}

// Сообщения запроса, или null, если это не запрос к модели (например, генерация картинки).
function extractRequestMessages(data) {
    if (Array.isArray(data?.messages)) {
        return data.messages.map(message => ({
            role: String(message?.role || ""),
            name: typeof message?.name === "string" ? message.name : undefined,
            text: messageText(message),
            tokens: null,
        }));
    }
    if (typeof data?.prompt === "string") {
        return [{ role: "prompt", text: data.prompt, tokens: null }];
    }
    return null;
}

function captureStack() {
    const previousLimit = Error.stackTraceLimit;
    try {
        Error.stackTraceLimit = STACK_LIMIT;
        return new Error().stack || "";
    } catch {
        return "";
    } finally {
        try { Error.stackTraceLimit = previousLimit; } catch { /* ignore */ }
    }
}

// Есть ли в стеке вызов функции с таким именем (формат Chrome и Firefox).
function stackHasFunction(stack, name) {
    return new RegExp(`(?:\\bat (?:async )?|^|\\*)${name}(?: \\(|@)`, "m").test(stack);
}

// Папки расширений (встроенных и сторонних) в стеке, кроме нашей, сверху вниз.
function foreignExtensionPaths(stack) {
    const paths = [];
    const re = /\/scripts\/extensions\/((?:third-party\/)?[^/\s:)]+)\//g;
    let match;
    while ((match = re.exec(stack)) !== null) {
        const path = decodeURIComponent(match[1]);
        if (path !== OWN_PATH && path !== "third-party" && !paths.includes(path)) paths.push(path);
    }
    return paths;
}

// Кто отправил боковой запрос: самое нижнее чужое расширение в стеке — это инициатор,
// а не какая-нибудь обёртка над fetch, которая оказалась между ним и нами.
function detectSourcePath(stack) {
    const paths = foreignExtensionPaths(stack);
    return paths.length ? paths[paths.length - 1] : null;
}

// Решаем, основной это запрос или боковой. Признаки по убыванию надёжности.
function classifyRequest(data, stack) {
    // 1. Таверна сама пишет тип генерации в тело запроса Chat Completion.
    if (typeof data?.type === "string" && data.type.length > 0) {
        return { isMain: data.type !== "quiet", via: `type=${data.type}` };
    }

    // 2. Стек: основной ответ идёт из Generate, тихие — через generateQuietPrompt / generateRaw.
    const quietInStack = stackHasFunction(stack, "generateQuietPrompt") || stackHasFunction(stack, "generateRaw");
    if (stackHasFunction(stack, "Generate")) {
        return { isMain: !quietInStack && lastStartedType !== "quiet", via: "stack:Generate" };
    }
    if (quietInStack) {
        return { isMain: false, via: "stack:quiet" };
    }

    // 3. Запасной вариант: таверна объявила основную генерацию, а в стеке нет чужих расширений.
    const isMain = mainGenerationActive && foreignExtensionPaths(stack).length === 0;
    return { isMain, via: "event" };
}

async function countTokens(text) {
    const context = getContext();
    if (typeof context?.getTokenCountAsync === "function") {
        return await context.getTokenCountAsync(text);
    }
    if (typeof context?.getTokenCount === "function") {
        return context.getTokenCount(text);
    }
    console.warn(LOG, "Tokenizer is not available");
    return 0;
}

// Chat Completion: считаем каждое сообщение тем же способом, что и Prompt Manager.
// Таверна уже посчитала эти сообщения при сборке промта, так что почти всё берётся из её кэша,
// а итог совпадает с «Total Tokens» в Prompt Manager.
async function countChatMessages(messages) {
    const countFn = stTokenizers?.countTokensOpenAIAsync;
    let total = 0;
    for (const message of messages) {
        if (!message.text) {
            message.tokens = 0;
            continue;
        }
        if (typeof countFn === "function") {
            const payload = { role: message.role, content: message.text };
            if (message.name !== undefined) payload.name = message.name;
            message.tokens = await countFn(payload);
        } else {
            message.tokens = await countTokens(message.text);
        }
        total += message.tokens;
    }
    return total;
}

// Снимок того, что таверна знала о промте в момент отправки основного запроса.
function snapshotPromptState() {
    try {
        const context = getContext();
        if (context?.mainApi !== "openai") return null;

        const counts = stOpenAI?.promptManager?.tokenHandler?.getCounts?.();
        if (!counts) return null;

        const extensionPrompts = Object.entries(context.extensionPrompts || {})
            .filter(([, prompt]) => prompt && typeof prompt.value === "string" && prompt.value.trim())
            .map(([key, prompt]) => ({
                key,
                value: prompt.value,
                position: Number(prompt.position),
                filter: typeof prompt.filter === "function" ? prompt.filter : null,
            }));

        const messagesInContext = typeof stOpenAI?.openai_messages_count === "number" ? stOpenAI.openai_messages_count : null;

        return { counts: { ...counts }, extensionPrompts, messagesInContext };
    } catch (e) {
        console.error(LOG, "Prompt snapshot failed:", e);
        return null;
    }
}

// Куда отнести инъекцию: карточка, лорбук, отдельное расширение или пропустить.
function classifyExtensionPrompt(key) {
    if (key === "QUIET_PROMPT" || key.startsWith("customWIOutlet_")) return { kind: "skip" };
    if (key.startsWith("customDepthWI")) return { kind: "lore" };
    if (key === "DEPTH_PROMPT" || /^DEPTH_PROMPT_\d+$/.test(key) || key === "PERSONA_DESCRIPTION" || key === "__STORY_STRING__") {
        return { kind: "card" };
    }
    return { kind: "extension", label: BUILTIN_EXTENSION_LABELS[key] || key };
}

// Раскладываем основной запрос по корзинкам. Каждый блок попадает ровно в одну строку.
async function computeBreakdown(snapshot, total) {
    let preset = 0, card = 0, lore = 0, history = 0;

    for (const [id, value] of Object.entries(snapshot.counts)) {
        const n = Number(value) || 0;
        if (n <= 0) continue;
        if (id === HISTORY_PROMPT_ID) history += n;
        else if (CARD_PROMPT_IDS.includes(id)) card += n;
        else if (LORE_PROMPT_IDS.includes(id)) lore += n;
        else preset += n;
    }

    // Инъекции: «в промт» таверна вклеивает внутрь главного блока пресета, «на глубине» — в историю.
    // Поэтому их размер вычитаем оттуда, куда они вклеены, и показываем отдельно.
    const extensions = new Map();
    for (const prompt of snapshot.extensionPrompts) {
        if (![EXT_POSITION.IN_PROMPT, EXT_POSITION.IN_CHAT, EXT_POSITION.BEFORE_PROMPT].includes(prompt.position)) continue;

        const target = classifyExtensionPrompt(prompt.key);
        if (target.kind === "skip") continue;

        if (prompt.filter) {
            try {
                if (!await prompt.filter()) continue;
            } catch {
                continue;
            }
        }

        const tokens = await countTokens(prompt.value);
        if (prompt.position === EXT_POSITION.IN_CHAT) history -= tokens;
        else preset -= tokens;

        if (target.kind === "card") card += tokens;
        else if (target.kind === "lore") lore += tokens;
        else extensions.set(target.label, (extensions.get(target.label) || 0) + tokens);
    }

    preset = Math.max(0, preset);
    history = Math.max(0, history);

    const lines = [];
    if (preset > 0) lines.push({ kind: "base", label: "Пресет", tokens: preset });
    if (card > 0) lines.push({ kind: "base", label: "Карточка", tokens: card });
    if (lore > 0) lines.push({ kind: "base", label: "Лорбук", tokens: lore });
    if (history > 0) {
        lines.push({
            kind: "base",
            label: "История чата",
            tokens: history,
            note: snapshot.messagesInContext !== null ? `сообщений в контексте: ${snapshot.messagesInContext}` : "",
        });
    }

    [...extensions.entries()]
        .filter(([, tokens]) => tokens > 0)
        .sort((a, b) => b[1] - a[1])
        .forEach(([label, tokens]) => lines.push({ kind: "extension", label, tokens }));

    const sum = lines.reduce((acc, line) => acc + line.tokens, 0);
    return { lines, other: total - sum };
}

async function finishMainBreakdown(snapshot, total, epoch) {
    try {
        if (!snapshot) {
            if (epoch === mainEpoch) lastBreakdown = { epoch, status: "unsupported", total };
            return;
        }
        const { lines, other } = await computeBreakdown(snapshot, total);
        if (epoch !== mainEpoch) return;
        lastBreakdown = { epoch, status: "ready", total, lines, other };
    } catch (e) {
        console.error(LOG, "Breakdown failed:", e);
        if (epoch === mainEpoch) lastBreakdown = { epoch, status: "unsupported", total };
    } finally {
        renderPanel();
    }
}

function inspectRequest(args) {
    const url = getRequestUrl(args[0]);
    if (!isGenerationUrl(url)) return;

    const body = args[1]?.body;
    if (typeof body !== "string") return;

    let data;
    try {
        data = JSON.parse(body);
    } catch {
        return;
    }

    const messages = extractRequestMessages(data);
    if (messages === null) return;
    const isChatCompletion = Array.isArray(data?.messages);

    // Стек снимаем сразу, синхронно — пока видно, кто нас вызвал.
    const stack = captureStack();
    const { isMain, via } = classifyRequest(data, stack);
    const sourcePath = isMain ? null : detectSourcePath(stack);

    if (!isMain && isExcluded(sourcePath)) {
        console.debug(LOG, "ignored request (excluded)", { url, source: sourcePath });
        return;
    }

    const entry = {
        id: ++entryCounter,
        time: new Date(),
        chatName: currentChatName(),
        isMain,
        sourcePath,
        sourceLabel: isMain ? MAIN_SOURCE_LABEL : (sourcePath ? sourcePath.split("/").pop() : UNKNOWN_SOURCE_LABEL),
        model: typeof data?.model === "string" ? data.model : "",
        messages,
        totalTokens: null,
        messagesCounting: false,
        messagesCounted: false,
    };
    addHistoryEntry(entry);

    if (sourcePath) {
        getExtensionLabel(sourcePath).then(label => {
            entry.sourceLabel = label;
            renderPanel();
        });
    }

    console.debug(LOG, isMain ? "main request" : "side request", { url, via, source: sourcePath });

    // Снимок промта берём синхронно, пока таверна не пересчитала его для чего-нибудь ещё.
    const snapshot = isMain && isChatCompletion ? snapshotPromptState() : null;

    const epoch = isMain ? ++mainEpoch : mainEpoch;
    if (isMain) {
        mainGenerationActive = false;
        sideTokensSinceMain = 0;
        lastBreakdown = { epoch, status: "counting" };
        updateContextDisplay();
        renderPanel();
    }

    const counting = isChatCompletion
        ? countChatMessages(messages).then(total => {
            entry.messagesCounted = true;
            return total;
        })
        : countTokens(messages.map(m => m.text).join("\n"));

    counting.then(tokens => {
        entry.totalTokens = tokens;
        renderPanel();

        if (epoch !== mainEpoch) return; // уже пришёл более свежий основной запрос / сменился чат
        if (isMain) {
            lastMainTokens = tokens;
            finishMainBreakdown(snapshot, tokens, epoch);
        } else {
            sideTokensSinceMain += tokens;
        }
        updateContextDisplay();
    }).catch(e => console.error(LOG, "Token count failed:", e));
}

function installFetchInterceptor() {
    if (window.fetch?.__tkwWrapped) return;

    const originalFetch = window.fetch;
    const wrappedFetch = function (...args) {
        try {
            inspectRequest(args);
        } catch (e) {
            console.error(LOG, "Error inspecting request:", e);
        }
        // Запрос уходит как есть, ничего не меняем и не ждём.
        return originalFetch.apply(window, args);
    };
    wrappedFetch.__tkwWrapped = true;
    window.fetch = wrappedFetch;
}

// =====================================================================
// Запуск
// =====================================================================

function bindSettingsHandlers() {
    $("#tkw_enabled").on("input", function () {
        const val = $(this).prop("checked");
        extension_settings[extensionName].enabled = val;
        saveSettingsDebounced();
        if (val) {
            createIndicator();
            startChatObserver();
        } else {
            removeIndicator();
            if (chatObserver) chatObserver.disconnect();
        }
    });

    $("#tkw_position").on("change", function () {
        extension_settings[extensionName].freePosition = null;
        updateSetting("position", $(this).val());
    });

    $("#tkw_opacity").on("input", function () {
        const val = parseFloat($(this).val());
        $("#tkw_opacity_value").text(Math.round(val * 100) + "%");
        updateSetting("opacity", val);
    });

    $("#tkw_scale").on("input", function () {
        const val = parseFloat($(this).val());
        $("#tkw_scale_value").text(val.toFixed(1) + "x");
        updateSetting("scale", val);
    });

    $("#tkw_bg_color").on("input", function () {
        updateSetting("bgColor", String($(this).val() || "#000000"));
    });

    $("#tkw_bg_opacity").on("input", function () {
        const val = parseFloat($(this).val());
        $("#tkw_bg_opacity_value").text(Math.round(val * 100) + "%");
        updateSetting("bgOpacity", val);
    });

    $("#tkw_border_radius").on("input", function () {
        const val = parseInt($(this).val());
        $("#tkw_border_radius_value").text(val + "px");
        updateSetting("borderRadius", val);
    });

    $("#tkw_use_fixed_text_color").on("input", function () {
        updateSetting("useFixedTextColor", $(this).prop("checked"));
    });

    $("#tkw_text_color").on("input", function () {
        updateSetting("textColor", String($(this).val() || "#ffffff"));
    });

    $("#tkw_text_opacity").on("input", function () {
        const val = parseFloat($(this).val());
        $("#tkw_text_opacity_value").text(Math.round(val * 100) + "%");
        updateSetting("textOpacity", val);
    });

    $("#tkw_show_max").on("input", function () {
        updateSetting("showMax", $(this).prop("checked"));
    });

    $("#tkw_use_custom_max").on("input", function () {
        updateSetting("useCustomMax", $(this).prop("checked"));
    });

    $("#tkw_custom_max").on("input", function () {
        updateSetting("customMax", parseInt($(this).val()) || 32000);
    });

    $("#tkw_show_side").on("input", function () {
        updateSetting("showSideOnIndicator", $(this).prop("checked"));
    });

    $("#tkw_history_size").on("change", function () {
        const val = clampHistorySize($(this).val());
        $(this).val(val);
        updateSetting("historySize", val);
    });

    $("#tkw_excluded_list").on("click", ".tkw-restore", function () {
        restoreSource(String($(this).data("path")));
    });

    $("#tkw_show_hidden").on("input", function () {
        updateSetting("showHiddenCounter", $(this).prop("checked"));
    });

    $("#tkw_hidden_position").on("change", function () {
        updateSetting("hiddenCounterPosition", $(this).val());
    });
}

function bindEvents() {
    eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun) return;
        lastStartedType = type;
        if (type !== "quiet") mainGenerationActive = true;
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        mainGenerationActive = false;
        updateContextDisplay();
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        mainGenerationActive = false;
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, updateContextDisplay);
    eventSource.on(event_types.MESSAGE_SENT, updateContextDisplay);
    eventSource.on(event_types.MESSAGE_DELETED, updateContextDisplay);
    eventSource.on(event_types.MESSAGE_EDITED, updateContextDisplay);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (RESET_ON_CHAT_CHANGED) {
            lastMainTokens = 0;
            sideTokensSinceMain = 0;
            lastBreakdown = null;
            mainEpoch++; // недосчитанные запросы прошлого чата не долетят до табло
        }
        mainGenerationActive = false;
        updateContextDisplay();
        renderPanel();
        startChatObserver();
    });

    $(window).on("resize.tkw", positionPanel);
    $(document).on("keydown.tkw", (e) => {
        if (e.key === "Escape" && panelOpen) closePanel();
    });
}

async function loadStModules() {
    try {
        stTokenizers = await import("../../../tokenizers.js");
    } catch (e) {
        console.warn(LOG, "Could not load tokenizers module, falling back to plain counting:", e);
    }
    try {
        stOpenAI = await import("../../../openai.js");
    } catch (e) {
        console.warn(LOG, "Could not load openai module, breakdown will be unavailable:", e);
    }
}

jQuery(async () => {
    try {
        const settingsHtml = await $.get(new URL("settings.html", import.meta.url).href);
        $("#extensions_settings2").append(settingsHtml);

        await loadSettings();
        await loadStModules();
        installFetchInterceptor();
        bindSettingsHandlers();
        bindEvents();

        if (extension_settings[extensionName].enabled) {
            createIndicator();
        }

        setTimeout(startChatObserver, 2000);
        setTimeout(updateContextDisplay, 1000);

        console.log(LOG, "Loaded");
    } catch (error) {
        console.error(LOG, "Failed to load:", error);
    }
});
