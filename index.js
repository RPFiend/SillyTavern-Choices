import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const extensionName = "SillyTavern-Choices";
const extensionId = "sillytavern_choices";

// Abort flag to prevent concurrent generation
let isGenerating = false;

// Trigger ST's chat save directly via the global function
function triggerChatSave() {
    const context = SillyTavern.getContext();
    if (typeof context.saveChat === 'function') {
        context.saveChat();
    } else if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
}

const defaultSettings = {
    enabled: true,
    llm_prompt: `Stop roleplay now and provide a response with {{suggestionNumber}} brief distinct single-sentence suggestions for next story beat on {{user}} perspective. Ensure each suggestion aligns with its corresponding description: 1. Eases tension and improves protagonist's situation 2. Creates or increases tension and worsens protagonist's situation 3. Leads directly but believably to a wild twist or super weird event 4. Slowly moves the story forward without ending the current scene 5. Pushes the story forward, potentially ending the current scene if feasible Each suggestion surrounded by \`\` tags. E.g: suggestion_1 suggestion_2 ... Do not include any other content in your response.`,
    llm_prompt_impersonate: `\`{{suggestionText}}\``,
    apply_wi_an: true,
    num_responses: 5,
    response_length: 500,
};

let extensionSettings = { ...defaultSettings };

// Load settings from SillyTavern
function loadSettings() {
    const { extensionSettings: stSettings } = SillyTavern.getContext();
    
    if (stSettings[extensionId]) {
        extensionSettings = { ...defaultSettings, ...stSettings[extensionId] };
    } else {
        extensionSettings = { ...defaultSettings };
    }
}

// Save settings to SillyTavern
function saveSettings() {
    const { extensionSettings: stSettings, saveSettingsDebounced } = SillyTavern.getContext();
    
    stSettings[extensionId] = { ...extensionSettings };
    
    if (saveSettingsDebounced) {
        saveSettingsDebounced();
    }
}

// Generate suggestions using generateQuietPrompt
async function generateSuggestions() {
    if (isGenerating) return;
    isGenerating = true;
    try {
        const { chat, generateQuietPrompt } = SillyTavern.getContext();
        if (!extensionSettings?.enabled) return;
        if (chat.length === 0) return;

        const prompt = extensionSettings.llm_prompt
            .replace('{{suggestionNumber}}', extensionSettings.num_responses);
        const response = await generateQuietPrompt(
            prompt,
            false,
            extensionSettings.apply_wi_an,
            extensionSettings.response_length
        );
        if (!response) return;

        const suggestions = parseSuggestions(response);
        console.log(`[${extensionName}] Parsed suggestions:`, suggestions);
        if (suggestions.length === 0) return;
        renderSuggestions(suggestions, chat.length - 1);
    } catch (error) {
        console.error(`[${extensionName}] Error:`, error);
    } finally {
        isGenerating = false;
    }
}

// Parse suggestions from LLM response
function parseSuggestions(response) {
    const strategies = [
        // <suggestion_1>text</suggestion_1>
        () => [...response.matchAll(/<suggestion_\d+>([\s\S]*?)<\/suggestion_\d+>/g)].map(m => m[1].trim()),

        // <option_1>text</option_1> or <choice_1>text</choice_1>
        () => [...response.matchAll(/<(?:option|choice)_\d+>([\s\S]*?)<\/(?:option|choice)_\d+>/g)].map(m => m[1].trim()),

        // `text`  (backtick-wrapped)
        () => [...response.matchAll(/`([^`\n]+)`/g)].map(m => m[1].trim()),

        // "text"  (quote-wrapped, full lines)
        () => [...response.matchAll(/^"([^"]+)"$/gm)].map(m => m[1].trim()),

        // 1. text  or  1) text
        () => [...response.matchAll(/^\d+[.)]\s+(.+)$/gm)].map(m => m[1].trim()),

        // - text  or  * text  (bullet lists)
        () => [...response.matchAll(/^[-*]\s+(.+)$/gm)].map(m => m[1].trim()),
    ];

    for (const strategy of strategies) {
        try {
            const results = strategy().filter(s => s.length > 0);
            if (results.length > 0) {
                console.log('[ST-Choices] Parsed suggestions:', results);
                return results;
            }
        } catch (e) { continue; }
    }

    return [];
}

// Render suggestion buttons in chat
function renderSuggestions(suggestions, messageId, fromPersistence = false) {
    const { chat } = SillyTavern.getContext();

    // Only save if this is a fresh generation, not a restore
    if (!fromPersistence && chat[messageId]) {
        if (!chat[messageId].extra) chat[messageId].extra = {};
        chat[messageId].extra.st_choices = suggestions;
        console.log(`[${extensionName}] Saved suggestions to message ${messageId}:`, chat[messageId].extra.st_choices);
        triggerChatSave();
    }

    setTimeout(() => {
        const $message = $(`.mes[mesid="${messageId}"]`);
        if ($message.length === 0) {
            console.error('[ST-Choices] Could not find message element for mesid:', messageId);
            return;
        }
        
        console.log('[SillyTavern-Choices] Rendering buttons:', suggestions);
        
        // Remove any existing suggestion container on this message
        $message.find('.st-choices-container').remove();
        
        const $container = $('<div class="st-choices-container"></div>');
        suggestions.forEach((text, index) => {
            const $btn = $('<button class="st-choices-btn menu_button"></button>');
            $btn.text(`${index + 1}. ${text}`);
            $btn.on('click', () => handleSuggestionClick(text));
            $container.append($btn);
        });

        // Add Regenerate Suggestions button
        const $regenBtn = $('<button>')
            .addClass('st-choices-regen menu_button interactable')
            .attr({ tabindex: '0', role: 'button' })
            .text('↻ Regenerate Suggestions')
            .on('click', async () => {
                $('.st-choices-container').remove();
                await generateSuggestions();
            });
        $container.append($regenBtn);
        
        $message.find('.mes_text').after($container);
        console.log(`[${extensionName}] Rendered ${suggestions.length} suggestion buttons`);
    }, 300);
}

// Handle suggestion button click
function handleSuggestionClick(suggestionText) {
    const impersonatePrompt = extensionSettings.llm_prompt_impersonate.replace('{{suggestionText}}', suggestionText);
    console.log('[ST-Choices] Impersonation prompt:', impersonatePrompt);
    $('#send_textarea').val(impersonatePrompt).trigger('input');
    $('#send_but').trigger('click');
}

// Render settings panel
function renderSettings() {
    const settingsHTML = `
        <div class="cyoa-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>${extensionName}</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="cyoa-settings-content">
                        <label class="checkbox_label">
                            <input type="checkbox" id="${extensionId}_enabled" ${extensionSettings.enabled ? 'checked' : ''}>
                            <span>Enable ${extensionName}</span>
                        </label>
                        
                        <div class="cyoa-setting-group">
                            <label for="${extensionId}_num_responses">Number of Suggestions: <span id="${extensionId}_num_responses_value">${extensionSettings.num_responses}</span></label>
                            <input type="range" id="${extensionId}_num_responses" min="1" max="5" value="${extensionSettings.num_responses}">
                        </div>

                        <div class="cyoa-setting-group">
                            <label for="${extensionId}_llm_prompt">LLM Prompt:</label>
                            <textarea id="${extensionId}_llm_prompt" rows="10">${extensionSettings.llm_prompt}</textarea>
                        </div>

                        <div class="cyoa-setting-group">
                            <label for="${extensionId}_llm_prompt_impersonate">Impersonation Prompt:</label>
                            <textarea id="${extensionId}_llm_prompt_impersonate" rows="5">${extensionSettings.llm_prompt_impersonate}</textarea>
                        </div>

                        <div class="cyoa-setting-group">
                            <label class="checkbox_label">
                                <input type="checkbox" id="${extensionId}_apply_wi_an" ${extensionSettings.apply_wi_an ? 'checked' : ''}>
                                <span>Apply World Info / Author's Note</span>
                            </label>
                        </div>

                        <div class="cyoa-setting-group">
                            <label for="${extensionId}_response_length">Response Length: <span id="${extensionId}_response_length_value">${extensionSettings.response_length}</span></label>
                            <input type="range" id="${extensionId}_response_length" min="100" max="2000" step="50" value="${extensionSettings.response_length}">
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Inject settings HTML
    $('#extensions_settings').append(settingsHTML);

    // Bind events
    $(`#${extensionId}_enabled`).on('change', function() {
        extensionSettings.enabled = $(this).prop('checked');
        saveSettings();
    });

    $(`#${extensionId}_num_responses`).on('input', function() {
        extensionSettings.num_responses = parseInt($(this).val());
        $(`#${extensionId}_num_responses_value`).text(extensionSettings.num_responses);
        saveSettings();
    });

    $(`#${extensionId}_llm_prompt`).on('input', function() {
        extensionSettings.llm_prompt = $(this).val();
        saveSettings();
    });

    $(`#${extensionId}_llm_prompt_impersonate`).on('input', function() {
        extensionSettings.llm_prompt_impersonate = $(this).val();
        saveSettings();
    });

    $(`#${extensionId}_apply_wi_an`).on('change', function() {
        extensionSettings.apply_wi_an = $(this).prop('checked');
        saveSettings();
    });

    $(`#${extensionId}_response_length`).on('input', function() {
        extensionSettings.response_length = parseInt($(this).val());
        $(`#${extensionId}_response_length_value`).text(extensionSettings.response_length);
        saveSettings();
    });
}

// Register slash command
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'cyoa',
    callback: () => { generateSuggestions(); return ''; },
    helpString: 'Manually trigger CYOA story suggestions.',
}));

// Initialize extension
$(document).ready(async function() {
    console.log(`[${extensionName}] Initializing...`);
    console.log(`[${extensionName}] Active API: ${SillyTavern.getContext().mainApi}`);

    loadSettings();
    renderSettings();

    // Get eventSource from context
    const { eventSource, event_types } = SillyTavern.getContext();

    // Listen for generation stopped/ended to reset abort flag
    eventSource.on(event_types.GENERATION_STOPPED, () => { isGenerating = false; });
    eventSource.on(event_types.GENERATION_ENDED, () => { isGenerating = false; });

    // Restore suggestions on chat load
    eventSource.on(event_types.CHAT_CHANGED, () => {
        const { chat } = SillyTavern.getContext();
        if (!chat || chat.length === 0) return;
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message?.extra?.st_choices?.length > 0 && !message.is_user) {
                console.log(`[${extensionName}] Restoring ${message.extra.st_choices.length} suggestions for message ${i}`);
                setTimeout(() => renderSuggestions(message.extra.st_choices, i, true), 600);
                break;
            }
        }
    });

    // Clear suggestions on swipe and generation start
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
        $('.st-choices-container').remove();
        const { chat } = SillyTavern.getContext();
        if (chat[messageId]?.extra?.st_choices) {
            delete chat[messageId].extra.st_choices;
            triggerChatSave();
        }
    });
    eventSource.on(event_types.GENERATION_STARTED, () => {
        $('.st-choices-container').remove();
        const { chat } = SillyTavern.getContext();
        const lastMsg = chat[chat.length - 1];
        if (lastMsg?.extra?.st_choices) {
            delete lastMsg.extra.st_choices;
            triggerChatSave();
        }
    });

    // Listen for AI messages
    eventSource.on(event_types.MESSAGE_RECEIVED, function(data) {
        console.log('[SillyTavern-Choices] Extension loaded, event listener registered');
        console.log('[SillyTavern-Choices] MESSAGE_RECEIVED fired');
        console.log(`[${extensionName}] Message received:`, data);
        
        // Only generate after AI messages (user messages have 'is_user' or similar)
        if (data && !data.is_user) {
            console.log(`[${extensionName}] AI message received, generating suggestions...`);
            generateSuggestions();
        }
    });

    console.log(`[${extensionName}] Initialized successfully`);
});