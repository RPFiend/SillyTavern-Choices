import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const extensionName = "SillyTavern-Choices";
const extensionId = "sillytavern_choices";

const defaultSettings = {
    enabled: false,
    llm_prompt: `Stop the roleplay now and provide a response with {{suggestionNumber}} brief distinct single-sentence suggestions for the next story beat on {{user}} perspective. Ensure each suggestion aligns with its corresponding description: 1. Eases tension and improves the protagonist's situation 2. Creates or increases tension and worsens the protagonist's situation 3. Leads directly but believably to a wild twist or super weird event 4. Slowly moves the story forward without ending the current scene 5. Pushes the story forward, potentially ending the current scene if feasible Each suggestion surrounded by \`\` tags. E.g: suggestion_1 suggestion_2 ... Do not include any other content in your response.`,
    llm_prompt_impersonate: `[Event Direction for the next story beat on {{user}} perspective: \`{{suggestionText}}\`] [Based on the expected events, write the user response]`,
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
    const { generateQuietPrompt, chat } = SillyTavern.getContext();
    
    if (!extensionSettings.enabled) {
        console.log(`[${extensionName}] Extension is disabled, skipping suggestion generation`);
        return;
    }

    if (chat.length === 0) {
        console.log(`[${extensionName}] No messages in chat, skipping suggestion generation`);
        return;
    }

    try {
        console.log('[ST-Choices] Generating suggestions...');

        // Prepare the prompt with suggestion number
        let prompt = extensionSettings.llm_prompt.replace('{{suggestionNumber}}', extensionSettings.num_responses);

        const response = await generateQuietPrompt(
            prompt,
            false,
            extensionSettings.apply_wi_an,
            extensionSettings.response_length
        );

        if (response) {
            console.log('[ST-Choices] Raw response:', response);
            const suggestions = parseSuggestions(response);
            if (suggestions.length > 0) {
                renderSuggestions(suggestions);
            }
        } else {
            console.log(`[${extensionName}] No response from generateQuietPrompt`);
        }
    } catch (error) {
        console.error(`[${extensionName}] Error generating suggestions:`, error);
    }
}

// Parse suggestions from LLM response
function parseSuggestions(response) {
    const suggestions = [];
    const regex = /<suggestion_\d+>([\s\S]*?)<\/suggestion_\d+>/g;
    let match;
    while ((match = regex.exec(response)) !== null) {
        const text = match[1].trim();
        if (text) suggestions.push(text);
    }
    return suggestions;
}

// Render suggestion buttons in chat
function renderSuggestions(suggestions) {
    const { chat } = SillyTavern.getContext();
    
    console.log('[ST-Choices] Rendering buttons:', suggestions);
    
    if (chat.length === 0) {
        console.log(`[${extensionName}] No messages in chat to append to`);
        return;
    }

    // Get the last message element
    const lastMessage = chat[chat.length - 1];
    const messageId = lastMessage.mesId;
    const messageElement = $(`.mes[mesid="${messageId}"]`);
    
    if (messageElement.length === 0) {
        console.error('[ST-Choices] Message element not found for mesid:', messageId);
        return;
    }

    // Remove existing suggestions for this message
    const existingContainer = messageElement.find('.cyoa-suggestions-container');
    if (existingContainer.length > 0) {
        existingContainer.remove();
    }

    // Create suggestions container
    const container = document.createElement('div');
    container.className = 'cyoa-suggestions-container';
    container.dataset.messageId = messageId;

    // Add label
    const label = document.createElement('div');
    label.className = 'cyoa-label';
    label.textContent = 'Choose Your Next Adventure:';
    container.appendChild(label);

    // Create button for each suggestion
    suggestions.forEach((suggestion, index) => {
        const button = document.createElement('button');
        button.className = 'cyoa-suggestion-button';
        button.textContent = `${index + 1}. ${suggestion}`;
        button.dataset.suggestion = suggestion;
        button.onclick = () => handleSuggestionClick(suggestion);
        container.appendChild(button);
    });

    // Append to message after .mes_text
    messageElement.find('.mes_text').after(container);

    console.log(`[${extensionName}] Rendered ${suggestions.length} suggestion buttons`);
}

// Handle suggestion button click
function handleSuggestionClick(suggestion) {
    const { substituteParamsExtended } = SillyTavern.getContext();
    
    console.log(`[${extensionName}] Suggestion clicked:`, suggestion);

    try {
        // Build the impersonation prompt
        let impersonatePrompt = extensionSettings.llm_prompt_impersonate.replace('{{suggestionText}}', suggestion);

        // Substitute parameters using ST's extended substitution
        impersonatePrompt = substituteParamsExtended(impersonatePrompt);

        // Set the text in the input area
        const textarea = document.getElementById('send_textarea');
        if (textarea) {
            textarea.value = impersonatePrompt;
            
            // Trigger input event to update UI
            const event = new Event('input', { bubbles: true });
            textarea.dispatchEvent(event);

            // Click the send button
            const sendButton = document.getElementById('send_but');
            if (sendButton) {
                sendButton.click();
                console.log(`[${extensionName}] Send button triggered`);
            } else {
                console.log(`[${extensionName}] Send button not found`);
            }
        } else {
            console.log(`[${extensionName}] Textarea not found`);
        }
    } catch (error) {
        console.error(`[${extensionName}] Error handling suggestion click:`, error);
    }
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
$(document).ready(function() {
    console.log(`[${extensionName}] Initializing...`);

    loadSettings();
    renderSettings();

    // Get eventSource from context
    const { eventSource, event_types } = SillyTavern.getContext();

    // Listen for AI messages
    eventSource.on(event_types.MESSAGE_RECEIVED, function(data) {
        console.log('[ST-Choices] Extension loaded, event listener registered');
        console.log('[ST-Choices] MESSAGE_RECEIVED fired');
        console.log(`[${extensionName}] Message received:`, data);
        
        // Only generate after AI messages (user messages have 'is_user' or similar)
        if (data && !data.is_user) {
            console.log(`[${extensionName}] AI message received, generating suggestions...`);
            generateSuggestions();
        }
    });

    console.log(`[${extensionName}] Initialized successfully`);
});
