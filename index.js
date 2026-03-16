import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const extensionName = "SillyTavern-Choices";
const extensionId = "sillytavern_choices";

// Abort flag to prevent concurrent generation
let isGenerating = false;

const defaultSettings = {
    enabled: true,
    completion_preset: '',
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
        const context = SillyTavern.getContext();
        const { chat, generateQuietPrompt } = context;
        if (!extensionSettings?.enabled) {
            console.log(`[${extensionName}] Extension is disabled, skipping suggestion generation`);
            return;
        }

        if (chat.length === 0) {
            console.log(`[${extensionName}] No messages in chat, skipping suggestion generation`);
            return;
        }

        const messageId = chat.length - 1;

        console.log('[ST-Choices] Generating suggestions...');

        // Save current preset name before switching
        const originalPreset = $('#settings_preset').val();

        try {
            // Switch to extension's preset if configured
            if (extensionSettings.completion_preset) {
                $('#settings_preset')
                    .val(extensionSettings.completion_preset)
                    .trigger('change');
                // Small delay to let ST apply the preset
                await new Promise(r => setTimeout(r, 300));
            }

            const prompt = extensionSettings.llm_prompt
                .replace('{{suggestionNumber}}', extensionSettings.num_responses);
            const response = await generateQuietPrompt(
                prompt,
                false,
                extensionSettings.apply_wi_an,
                extensionSettings.response_length
            );
            if (!response) {
                console.log(`[${extensionName}] No response from generateQuietPrompt`);
                return;
            }

            console.log('[ST-Choices] Raw response:', response);
            const suggestions = parseSuggestions(response);
            if (suggestions.length === 0) {
                console.log(`[${extensionName}] No suggestions found in response`);
                return;
            }

            renderSuggestions(suggestions, messageId);
        } finally {
            // Always restore original preset
            if (extensionSettings.completion_preset && originalPreset) {
                $('#settings_preset')
                    .val(originalPreset)
                    .trigger('change');
            }
        }
    } catch (error) {
        console.error(`[${extensionName}] Error generating suggestions:`, error);
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
function renderSuggestions(suggestions, messageId) {
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
                            <label for="st_choices_completion_preset">Completion Preset (leave blank to use current)</label>
                            <select id="st_choices_completion_preset" class="text_pole">
                                <option value="">-- Use Current Preset --</option>
                            </select>
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

    loadSettings();
    renderSettings();

    // Get eventSource from context
    const { eventSource, event_types } = SillyTavern.getContext();

    async function populatePresetDropdown() {
        const context = SillyTavern.getContext();
        const $dropdown = $('#st_choices_completion_preset');

        // Clear existing options except default
        $dropdown.find('option:not([value=""])').remove();

        // Use ST's context to get available presets for current API
        const presets = context.getPresetList ? context.getPresetList() : null;

        if (presets && presets.length > 0) {
            presets.forEach(preset => {
                $dropdown.append(
                    $('<option>').val(preset).text(preset)
                );
            });
        } else {
            // Fallback: read from the correct ST preset selector for current API type
            const $stPreset = $('#completionprompts_preset, #settings_preset, #chat_completion_preset').first();
            $stPreset.find('option').each(function() {
                const val = $(this).val();
                const text = $(this).text();
                if (val && val !== 'gui') {
                    $dropdown.append($('<option>').val(val).text(text));
                }
            });
        }

        // Restore saved selection
        $dropdown.val(extensionSettings.completion_preset || '');
    }

    // Call it on init and whenever the API type changes
    await populatePresetDropdown();
    eventSource.on(event_types.CHAT_CHANGED, populatePresetDropdown);

    // Bind preset change event
    $('#st_choices_completion_preset').on('change', function() {
        extensionSettings.completion_preset = $(this).val();
        const { saveSettingsDebounced } = SillyTavern.getContext();
        saveSettingsDebounced();
    });

    // Listen for generation stopped/ended to reset abort flag
    eventSource.on(event_types.GENERATION_STOPPED, () => { isGenerating = false; });
    eventSource.on(event_types.GENERATION_ENDED, () => { isGenerating = false; });

    // Clear suggestions on swipe and generation start
    eventSource.on(event_types.MESSAGE_SWIPED, () => {
        $('.st-choices-container').remove();
    });
    eventSource.on(event_types.GENERATION_STARTED, () => {
        $('.st-choices-container').remove();
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
