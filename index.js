import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
 
const MODULE_NAME = 'sillytavern_choices';
const EXTENSION_NAME = 'SillyTavern-Choices';
const STORAGE_KEY = 'st_choices';
 
let isGenerating = false;
 
// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
 
const defaultSettings = Object.freeze({
    enabled: true,
    llm_prompt: `Stop roleplay now and provide a response with {{suggestionNumber}} brief distinct single-sentence suggestions for next story beat on {{user}} perspective. Ensure each suggestion aligns with its corresponding description: 1. Eases tension and improves protagonist's situation 2. Creates or increases tension and worsens protagonist's situation 3. Leads directly but believably to a wild twist or super weird event 4. Slowly moves the story forward without ending the current scene 5. Pushes the story forward, potentially ending the current scene if feasible Each suggestion surrounded by \`\` tags. E.g: suggestion_1 suggestion_2 ... Do not include any other content in your response.`,
    llm_prompt_impersonate: '`{{suggestionText}}`',
    apply_wi_an: true,
    num_responses: 5,
    response_length: 500,
});
 
function loadSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    const { lodash } = SillyTavern.libs;
    extensionSettings[MODULE_NAME] = lodash.merge(
        structuredClone(defaultSettings),
        extensionSettings[MODULE_NAME],
    );
}
 
function getSettings() {
    return SillyTavern.getContext().extensionSettings[MODULE_NAME];
}
 
function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}
 
// ---------------------------------------------------------------------------
// Persistence — chatMetadata + saveMetadata()
//
// Confirmed present in getContext() from console dump.
// Never cache chatMetadata — re-fetch every call, reference changes on chat switch.
//
// Structure: chatMetadata[STORAGE_KEY] = { "<msgIndex>": ["choice1", ...] }
// ---------------------------------------------------------------------------
 
async function saveChoicesForMessage(messageIndex, choices) {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
 
    if (!chatMetadata[STORAGE_KEY]) {
        chatMetadata[STORAGE_KEY] = {};
    }
    chatMetadata[STORAGE_KEY][String(messageIndex)] = choices;
 
    await saveMetadata();
    console.log(`[${EXTENSION_NAME}] ✅ Saved choices for message ${messageIndex}:`, choices);
    console.log(`[${EXTENSION_NAME}] chatMetadata['${STORAGE_KEY}']:`, JSON.stringify(chatMetadata[STORAGE_KEY]));
}
 
async function clearChoicesForMessage(messageIndex) {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    const store = chatMetadata[STORAGE_KEY];
 
    if (store?.[String(messageIndex)] !== undefined) {
        delete store[String(messageIndex)];
        await saveMetadata();
        console.log(`[${EXTENSION_NAME}] 🗑 Cleared choices for message ${messageIndex}`);
    }
}
 
// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
 
/**
 * Polls for a .mes[mesid] element — needed after CHAT_CHANGED which fires
 * before ST finishes rendering the DOM.
 */
function waitForMessageElement(mesid, maxWaitMs = 3000) {
    return new Promise((resolve) => {
        const INTERVAL = 100;
        let elapsed = 0;
        const check = () => {
            if ($(`.mes[mesid="${mesid}"]`).length) {
                resolve(true);
            } else if (elapsed >= maxWaitMs) {
                console.warn(`[${EXTENSION_NAME}] ⚠ Timed out waiting for mesid=${mesid}`);
                resolve(false);
            } else {
                elapsed += INTERVAL;
                setTimeout(check, INTERVAL);
            }
        };
        check();
    });
}
 
// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
 
async function renderSuggestions(choices, messageIndex, skipSave = false) {
    if (!skipSave) {
        await saveChoicesForMessage(messageIndex, choices);
    }
 
    const $message = $(`.mes[mesid="${messageIndex}"]`);
    if (!$message.length) {
        console.error(`[${EXTENSION_NAME}] ❌ renderSuggestions: could not find mesid=${messageIndex}`);
        return;
    }
 
    $message.find('.st-choices-container').remove();
    const $container = $('<div class="st-choices-container"></div>');
 
    choices.forEach((text, index) => {
        $('<button class="st-choices-btn menu_button"></button>')
            .text(`${index + 1}. ${text}`)
            .on('click', () => handleChoiceClick(messageIndex, text))
            .appendTo($container);
    });
 
    $('<button class="st-choices-regen menu_button interactable" tabindex="0" role="button">↻ Regenerate Suggestions</button>')
        .on('click', async () => {
            await clearChoicesForMessage(messageIndex);
            $message.find('.st-choices-container').remove();
            await generateSuggestions();
        })
        .appendTo($container);
 
    $message.find('.mes_text').after($container);
    console.log(`[${EXTENSION_NAME}] ✅ Rendered ${choices.length} choices on message ${messageIndex}`);
}
 
async function restoreAllChoices() {
    // Re-fetch chatMetadata fresh — reference changes on chat switch
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    const store = chatMetadata[STORAGE_KEY];
 
    console.log(`[${EXTENSION_NAME}] 🔄 restoreAllChoices — store:`, store);
 
    if (!store || !Object.keys(store).length) {
        console.log(`[${EXTENSION_NAME}] No saved choices to restore`);
        return;
    }
 
    let restored = 0;
    let pruned = false;
 
    for (const [indexStr, choices] of Object.entries(store)) {
        const messageIndex = parseInt(indexStr, 10);
        if (!Array.isArray(choices) || !choices.length) continue;
 
        const found = await waitForMessageElement(messageIndex);
        if (!found) {
            console.warn(`[${EXTENSION_NAME}] ⚠ Pruning stale entry for mesid=${messageIndex}`);
            delete store[indexStr];
            pruned = true;
            continue;
        }
 
        await renderSuggestions(choices, messageIndex, /* skipSave */ true);
        restored++;
    }
 
    if (pruned) await saveMetadata();
    console.log(`[${EXTENSION_NAME}] ✅ Restored ${restored} choice set(s)`);
}
 
// ---------------------------------------------------------------------------
// Click handler
// ---------------------------------------------------------------------------
 
async function handleChoiceClick(messageIndex, choiceText) {
    // Clear saved data BEFORE sending so refresh won't restore stale buttons
    await clearChoicesForMessage(messageIndex);
 
    const prompt = getSettings().llm_prompt_impersonate
        .replace('{{suggestionText}}', choiceText);
 
    $('#send_textarea').val(prompt).trigger('input');
    $('#send_but').trigger('click');
}
 
// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
 
async function generateSuggestions() {
    if (isGenerating) return;
    isGenerating = true;
 
    try {
        const { chat, generateQuietPrompt } = SillyTavern.getContext();
        const settings = getSettings();
 
        if (!settings.enabled || !chat.length) return;
 
        const quietPrompt = settings.llm_prompt
            .replace('{{suggestionNumber}}', settings.num_responses);
 
        // Using confirmed-working positional argument form.
        // The object form { quietPrompt, skipWIAN, responseLength } was tried and
        // returned empty responses despite the generation running — reverting to
        // positional which is proven to work on this ST install.
        // Positional order: (quietPrompt, quietToLoud, addWIAN, responseLength)
        const response = await generateQuietPrompt(
            quietPrompt,
            false,
            settings.apply_wi_an,
            settings.response_length,
        );
 
        console.log(`[${EXTENSION_NAME}] generateQuietPrompt raw response:`, response);
 
        if (!response) {
            console.warn(`[${EXTENSION_NAME}] ⚠ Empty response from generateQuietPrompt`);
            return;
        }
 
        const choices = parseSuggestions(response);
        console.log(`[${EXTENSION_NAME}] Parsed ${choices.length} suggestions:`, choices);
        if (!choices.length) return;
 
        await renderSuggestions(choices, chat.length - 1);
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] ❌ generateSuggestions error:`, err);
    } finally {
        isGenerating = false;
    }
}
 
// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
 
function parseSuggestions(response) {
    const strategies = [
        () => [...response.matchAll(/<suggestion_\d+>([\s\S]*?)<\/suggestion_\d+>/g)].map(m => m[1].trim()),
        () => [...response.matchAll(/<(?:option|choice)_\d+>([\s\S]*?)<\/(?:option|choice)_\d+>/g)].map(m => m[1].trim()),
        () => [...response.matchAll(/`([^`\n]+)`/g)].map(m => m[1].trim()),
        () => [...response.matchAll(/^"([^"]+)"$/gm)].map(m => m[1].trim()),
        () => [...response.matchAll(/^\d+[.)]\s+(.+)$/gm)].map(m => m[1].trim()),
        () => [...response.matchAll(/^[-*]\s+(.+)$/gm)].map(m => m[1].trim()),
    ];
 
    for (const strategy of strategies) {
        try {
            const results = strategy().filter(s => s.length > 0);
            if (results.length) return results;
        } catch (_) { /* try next */ }
    }
    return [];
}
 
// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------
 
function renderSettings() {
    const settings = getSettings();
 
    const html = `
        <div class="cyoa-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>${EXTENSION_NAME}</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="cyoa-settings-content">
                        <label class="checkbox_label">
                            <input type="checkbox" id="${MODULE_NAME}_enabled" ${settings.enabled ? 'checked' : ''}>
                            <span>Enable ${EXTENSION_NAME}</span>
                        </label>
                        <div class="cyoa-setting-group">
                            <label for="${MODULE_NAME}_num_responses">
                                Number of Suggestions: <span id="${MODULE_NAME}_num_responses_value">${settings.num_responses}</span>
                            </label>
                            <input type="range" id="${MODULE_NAME}_num_responses" min="1" max="5" value="${settings.num_responses}">
                        </div>
                        <div class="cyoa-setting-group">
                            <label for="${MODULE_NAME}_llm_prompt">LLM Prompt:</label>
                            <textarea id="${MODULE_NAME}_llm_prompt" rows="10">${settings.llm_prompt}</textarea>
                        </div>
                        <div class="cyoa-setting-group">
                            <label for="${MODULE_NAME}_llm_prompt_impersonate">Impersonation Prompt:</label>
                            <textarea id="${MODULE_NAME}_llm_prompt_impersonate" rows="5">${settings.llm_prompt_impersonate}</textarea>
                        </div>
                        <div class="cyoa-setting-group">
                            <label class="checkbox_label">
                                <input type="checkbox" id="${MODULE_NAME}_apply_wi_an" ${settings.apply_wi_an ? 'checked' : ''}>
                                <span>Apply World Info / Author's Note</span>
                            </label>
                        </div>
                        <div class="cyoa-setting-group">
                            <label for="${MODULE_NAME}_response_length">
                                Response Length: <span id="${MODULE_NAME}_response_length_value">${settings.response_length}</span>
                            </label>
                            <input type="range" id="${MODULE_NAME}_response_length" min="100" max="2000" step="50" value="${settings.response_length}">
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
 
    $('#extensions_settings').append(html);
 
    $(`#${MODULE_NAME}_enabled`).on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
    });
    $(`#${MODULE_NAME}_num_responses`).on('input', function () {
        getSettings().num_responses = parseInt($(this).val());
        $(`#${MODULE_NAME}_num_responses_value`).text(getSettings().num_responses);
        saveSettings();
    });
    $(`#${MODULE_NAME}_llm_prompt`).on('input', function () {
        getSettings().llm_prompt = $(this).val();
        saveSettings();
    });
    $(`#${MODULE_NAME}_llm_prompt_impersonate`).on('input', function () {
        getSettings().llm_prompt_impersonate = $(this).val();
        saveSettings();
    });
    $(`#${MODULE_NAME}_apply_wi_an`).on('change', function () {
        getSettings().apply_wi_an = $(this).prop('checked');
        saveSettings();
    });
    $(`#${MODULE_NAME}_response_length`).on('input', function () {
        getSettings().response_length = parseInt($(this).val());
        $(`#${MODULE_NAME}_response_length_value`).text(getSettings().response_length);
        saveSettings();
    });
}
 
// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------
 
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'cyoa',
    callback: () => { generateSuggestions(); return ''; },
    helpString: 'Manually trigger CYOA story suggestions.',
}));
 
// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
 
$(document).ready(async function () {
    console.log(`[${EXTENSION_NAME}] Initializing...`);
 
    loadSettings();
    renderSettings();
 
    // Both eventTypes and event_types confirmed to work on this ST version.
    const { eventSource, eventTypes } = SillyTavern.getContext();
 
    eventSource.on(eventTypes.GENERATION_STOPPED, () => { isGenerating = false; });
    eventSource.on(eventTypes.GENERATION_ENDED,   () => { isGenerating = false; });
 
    // CHAT_CHANGED fires before DOM is fully rendered — restoreAllChoices polls for elements
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        console.log(`[${EXTENSION_NAME}] 🔔 CHAT_CHANGED`);
        restoreAllChoices();
    });
 
    // CHARACTER_MESSAGE_RENDERED fires AFTER the AI message element exists in the DOM.
    // Confirmed working from console: eventTypes.CHARACTER_MESSAGE_RENDERED = 'character_message_rendered'
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (messageIndex) => {
        console.log(`[${EXTENSION_NAME}] 🔔 CHARACTER_MESSAGE_RENDERED index=${messageIndex}`);
        generateSuggestions();
    });
 
    // GENERATION_STARTED: walk back through chat to find the last AI message and
    // clear its choices — chat.length-1 at this moment is the user's new message.
    eventSource.on(eventTypes.GENERATION_STARTED, async () => {
        const { chat } = SillyTavern.getContext();
        $('.st-choices-container').remove();
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user) {
                await clearChoicesForMessage(i);
                break;
            }
        }
    });
 
    eventSource.on(eventTypes.MESSAGE_SWIPED, async (messageIndex) => {
        $('.st-choices-container').remove();
        await clearChoicesForMessage(messageIndex);
    });
 
    console.log(`[${EXTENSION_NAME}] ✅ Initialized`);
});
 