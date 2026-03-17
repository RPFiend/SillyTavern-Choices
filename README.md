# SillyTavern Story Suggestions Extension – Choices!

After each AI message, get a set of clickable story suggestions. Pick one and your character acts it out automatically.

## Installation

1. In SillyTavern, go to **Extensions → Install Extension**
2. Paste this repo's GitHub URL
3. Restart SillyTavern

## Usage

Enable the extension in the Extensions panel. Suggestion buttons will appear automatically after each AI message. Click one to generate your next action.

To trigger suggestions manually, type `/cyoa` in the chat input.

## Features

- **Automatic suggestion generation** choices appear automatically after every AI message without any manual input

- **Multiple suggestions** configurable number of suggestions per response (set in extension settings)

- **One-click selection** clicking a suggestion automatically fills and submits the user input box with your chosen action

- **Regenerate button** every response includes a ↻ button to retry suggestion generation without resending your prompt

- **Persists across refresh** suggestions are saved to the chat file and restored when you reload the page

- **Swipe-aware** suggestions automatically clear when you swipe to a new AI response

- **Abort-safe** if the API call is cancelled or interrupted by another extension, the extension detects it and retries automatically

- **Compatible with other extensions** designed to work alongside extensions like SillyTavern-MessageSummarize without conflicting API calls

- **Wide LLM compatibility** parses suggestions from XML tag format, numbered lists, and bullet points to support a broad range of models

- **Configurable prompt** fully customizable LLM prompt in settings so you can tailor suggestion style and tone to your roleplay

- **Adjustable response length** control how long the suggestion generation response can be via the settings panel

- **World Info/Author's Note aware** optional toggle to include WI/AN context when generating suggestions

## Settings

- **Enable/Disable** toggle
- **Number of suggestions** (1–5)
- **LLM prompt** — customize how suggestions are generated
- **Impersonation prompt** — customize how your chosen action is written
- **Apply World Info/Author's Note** toggle
- **Response length** slider

## Requirements

- SillyTavern
- Any LLM API

## License

MIT
