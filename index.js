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
// Never cache chatMetadata — re-fetch from getContext() every call.
// Structure: chatMetadata[STORAGE_KEY] = { "<msgIndex>": ["choice1", ...] }
// ---------------------------------------------------------------------------

async function saveChoicesForMessage(messageIndex, choices) {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();

    if (!chatMetadata[STORAGE_KEY]) {
        chatMetadata[STORAGE_KEY] = {};
    }
    chatMetadata[STORAGE_KEY][String(messageIndex)] = choices;

    await saveMetadata();

    // Re-fetch after save to confirm the data landed on the live object
    const verify = SillyTavern.getContext().chatMetadata[STORAGE_KEY];
    console.log(`[${EXTENSION_NAME}] ✅ Save complete. Verified store:`, JSON.stringify(verify));
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

    // Remove any existing choices for this message
    $message.find('.st-choices-container').remove();

    const $container = $('<div>')
        .addClass('st-choices-container');

    // Main choice buttons
    choices.forEach((text, index) => {
        $('<button>')
            .addClass('st-choices-btn menu_button interactable')
            .attr({ tabindex: '0', role: 'button' })
            .text(`${index + 1}. ${text}`)
            .on('click', () => handleChoiceClick(messageIndex, text))
            .appendTo($container);
    });

    // Regenerate button (manual retry)
    $('<button>')
        .addClass('st-choices-regen menu_button interactable')
        .attr({ tabindex: '0', role: 'button' })
        .text('↻ Regenerate suggestions')
        .on('click', async () => {
            console.log(`[${EXTENSION_NAME}] ↻ Manual regenerate clicked for message ${messageIndex}`);
            await clearChoicesForMessage(messageIndex);
            $message.find('.st-choices-container').remove();
            await generateSuggestions();
        })
        .appendTo($container);

    $message.find('.mes_text').after($container);
    console.log(`[${EXTENSION_NAME}] ✅ Rendered ${choices.length} choices on message ${messageIndex}`);
}

async function restoreAllChoices() {
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

        // Positional args confirmed working on this ST install
        const response = await generateQuietPrompt(
            quietPrompt,
            false,
            settings.apply_wi_an,
            settings.response_length,
        );

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
    const suggestions = [];

    // Match <suggestion_N>content</suggestion_N> and capture only the inner content
    const tagPattern = /<suggestion_(\d+)>([\s\S]*?)<\/suggestion_\1>/gi;
    let match;
    while ((match = tagPattern.exec(response)) !== null) {
        const text = match[2].trim();
        if (text) suggestions.push(text);
    }

    // Fallback: numbered list format (1. text or 1) text)
    if (suggestions.length === 0) {
        const listPattern = /^\s*\d+[.)]\s+(.+)$/gm;
        while ((match = listPattern.exec(response)) !== null) {
            const text = match[1].trim();
            if (text) suggestions.push(text);
        }
    }

    console.log(`[${EXTENSION_NAME}] Parsed suggestions:`, suggestions);
    return suggestions;
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

    const { eventSource, eventTypes } = SillyTavern.getContext();

    eventSource.on(eventTypes.GENERATION_STOPPED, () => { isGenerating = false; });
    eventSource.on(eventTypes.GENERATION_ENDED,   () => { isGenerating = false; });

    // CHAT_CHANGED: restore persisted choices. Fires before DOM is ready, so we poll.
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        console.log(`[${EXTENSION_NAME}] 🔔 CHAT_CHANGED`);
        restoreAllChoices();
    });

    // CHARACTER_MESSAGE_RENDERED: fires after the AI message is in the DOM.
    // Confirmed working: eventTypes.CHARACTER_MESSAGE_RENDERED = 'character_message_rendered'
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (messageIndex) => {
        console.log(`[${EXTENSION_NAME}] 🔔 CHARACTER_MESSAGE_RENDERED index=${messageIndex}`);
        generateSuggestions();
    });

    // KEY FIX: use USER_MESSAGE_RENDERED instead of GENERATION_STARTED.
    //
    // GENERATION_STARTED fires for ALL generations including our own generateQuietPrompt,
    // which was deleting the choices we just saved before the chat could be written to disk.
    //
    // USER_MESSAGE_RENDERED only fires when the user sends a real message, so it correctly
    // clears old choices only when the user has actually moved the story forward.
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, async () => {
        console.log(`[${EXTENSION_NAME}] 🔔 USER_MESSAGE_RENDERED — clearing old choices`);
        const { chat } = SillyTavern.getContext();
        $('.st-choices-container').remove();

        // Walk back to find the last AI message before the one just sent
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user) {
                await clearChoicesForMessage(i);
                break;
            }
        }
    });

    // MESSAGE_SWIPED: user is regenerating — old choices are stale
    eventSource.on(eventTypes.MESSAGE_SWIPED, async (messageIndex) => {
        console.log(`[${EXTENSION_NAME}] 🔔 MESSAGE_SWIPED index=${messageIndex}`);
        $('.st-choices-container').remove();
        await clearChoicesForMessage(messageIndex);
    });

    console.log(`[${EXTENSION_NAME}] ✅ Initialized`);
});