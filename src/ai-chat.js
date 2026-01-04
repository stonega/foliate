import Gtk from 'gi://Gtk'
import Adw from 'gi://Adw'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import GObject from 'gi://GObject'
import Gdk from 'gi://Gdk'
import Soup from 'gi://Soup'
import { gettext as _ } from 'gettext'

import * as utils from './utils.js'
import { WebView } from './webview.js'

const CHAT_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
:root {
    color-scheme: light dark;
}
body {
    font-family: sans-serif;
    margin: 0;
    padding: 10px;
    color: CanvasText;
    background-color: transparent;
}
.message {
    margin-bottom: 12px;
    padding: 10px 14px;
    border-radius: 12px;
    width: fit-content;
    max-width: 90%;
    word-wrap: break-word;
}
.user {
    background-color: var(--user-bg, AccentColor);
    color: var(--user-fg, AccentColorText);
    margin-left: auto;
    border-bottom-right-radius: 4px;
}
.assistant {
    background-color: rgba(127, 127, 127, 0.1);
    color: CanvasText;
    margin-right: auto;
    border-bottom-left-radius: 4px;
}
.error {
    background-color: rgba(255, 0, 0, 0.1);
    border: 1px solid rgba(255, 0, 0, 0.5);
    color: CanvasText;
}
p { margin: 0 0 0.5em 0; }
p:last-child { margin-bottom: 0; }
pre {
    background-color: rgba(127, 127, 127, 0.1);
    padding: 8px;
    border-radius: 6px;
    overflow-x: auto;
}
code {
    font-family: monospace;
    background-color: rgba(127, 127, 127, 0.1);
    padding: 2px 4px;
    border-radius: 4px;
}
pre code {
    background-color: transparent;
    padding: 0;
}
</style>
</head>
<body>
<div id="messages"></div>
<script>
function addMessage(role, content, isError) {
    const div = document.createElement('div');
    div.className = 'message ' + role + (isError ? ' error' : '');
    
    if (isError) {
        div.textContent = content;
    } else {
        try {
            div.innerHTML = marked.parse(content);
        } catch (e) {
            console.error('Markdown parsing error:', e);
            div.textContent = content;
        }
    }
    
    document.getElementById('messages').appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
}

function clearMessages() {
    document.getElementById('messages').innerHTML = '';
}
</script>
</body>
</html>
`

// AI Message data class for chat history
const AIMessage = GObject.registerClass({
    GTypeName: 'FoliateAIMessage',
    Properties: utils.makeParams({
        'role': 'string',      // 'user' or 'assistant' or 'system'
        'content': 'string',
        'timestamp': 'string',
        'is-error': 'boolean',
    }),
}, class extends GObject.Object {
    constructor(params) {
        super(params)
        if (!this.timestamp) {
            this.timestamp = new Date().toISOString()
        }
    }

    toJSON() {
        return {
            role: this.role,
            content: this.content,
            timestamp: this.timestamp,
            isError: this.is_error,
        }
    }

    static fromJSON(obj) {
        return new AIMessage({
            role: obj.role,
            content: obj.content,
            timestamp: obj.timestamp,
            is_error: obj.isError || false,
        })
    }
})

// Chat Session class for storing a complete conversation
const ChatSession = GObject.registerClass({
    GTypeName: 'FoliateChatSession',
    Properties: utils.makeParams({
        'id': 'string',
        'title': 'string',
        'created': 'string',
        'updated': 'string',
        'book-title': 'string',
    }),
}, class extends GObject.Object {
    #messages = []

    constructor(params) {
        super(params)
        if (!this.id) {
            this.id = GLib.uuid_string_random()
        }
        if (!this.created) {
            this.created = new Date().toISOString()
        }
        this.updated = this.created
    }

    get messages() {
        return this.#messages
    }

    addMessage(message) {
        this.#messages.push(message)
        this.updated = new Date().toISOString()
        // Auto-generate title from first user message if not set
        // if (!this.title && message.role === 'user') {
        //     this.title = message.content.substring(0, 50) + (message.content.length > 50 ? '…' : '')
        // }
    }

    toJSON() {
        return {
            id: this.id,
            title: this.title,
            created: this.created,
            updated: this.updated,
            bookTitle: this.book_title,
            messages: this.#messages.map(m => m.toJSON()),
        }
    }

    static fromJSON(obj) {
        const session = new ChatSession({
            id: obj.id,
            title: obj.title,
            created: obj.created,
            updated: obj.updated,
            book_title: obj.bookTitle,
        })
        if (obj.messages) {
            for (const msg of obj.messages) {
                session.#messages.push(AIMessage.fromJSON(msg))
            }
        }
        return session
    }
})

// Chat History Manager - handles persistent storage of chat sessions
export class ChatHistoryManager {
    #storage
    #sessions = []

    constructor() {
        const path = GLib.build_filenamev([GLib.get_user_data_dir(), pkg.name, 'ai-chat'])
        GLib.mkdir_with_parents(path, 0o755)
        this.#storage = new utils.JSONStorage(path, 'history', 2)
        this.#loadSessions()

        // Listen for external modifications
        this.#storage.connect('externally-modified', () => this.#loadSessions())
    }

    #loadSessions() {
        try {
            const data = this.#storage.get('sessions', [])
            this.#sessions = data.map(s => ChatSession.fromJSON(s))
            // Sort by updated date, newest first
            this.#sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated))
        } catch (e) {
            console.error('Failed to load chat sessions:', e)
            this.#sessions = []
        }
    }

    #saveSessions() {
        try {
            this.#storage.set('sessions', this.#sessions.map(s => s.toJSON()))
        } catch (e) {
            console.error('Failed to save chat sessions:', e)
        }
    }

    get sessions() {
        return this.#sessions
    }

    createSession(bookTitle = null) {
        const session = new ChatSession({
            book_title: bookTitle,
        })
        // Don't save immediately - wait for assistant message
        // this.#sessions.unshift(session)
        // this.#saveSessions()
        return session
    }

    getSession(id) {
        return this.#sessions.find(s => s.id === id)
    }

    updateSession(session) {
        const index = this.#sessions.findIndex(s => s.id === session.id)
        if (index !== -1) {
            this.#sessions[index] = session
            // Re-sort by updated date
            this.#sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated))
        } else {
            // New session (upsert)
            this.#sessions.unshift(session)
        }
        this.#saveSessions()
    }

    deleteSession(id) {
        const index = this.#sessions.findIndex(s => s.id === id)
        if (index !== -1) {
            this.#sessions.splice(index, 1)
            this.#saveSessions()
        }
    }

    clearAllSessions() {
        this.#sessions = []
        this.#saveSessions()
    }
}

// Create singleton instance
export const chatHistoryManager = new ChatHistoryManager()

// Chat History Dialog
export const ChatHistoryDialog = GObject.registerClass({
    GTypeName: 'FoliateChatHistoryDialog',
    Signals: {
        'session-selected': { param_types: [GObject.TYPE_STRING] },
    },
}, class extends Adw.Dialog {
    #listBox

    constructor(params) {
        super({
            title: _('Chat History'),
            content_width: 400,
            content_height: 500,
            ...params,
        })

        const toolbarView = new Adw.ToolbarView()
        this.set_child(toolbarView)

        // Header bar
        const headerBar = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
        })
        headerBar.pack_start(new Gtk.Button({
            label: _('Close'),
            action_name: 'window.close',
        }))

        const clearButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Clear All History'),
            css_classes: ['flat'],
        })
        clearButton.connect('clicked', () => this.#confirmClearAll())
        headerBar.pack_end(clearButton)

        toolbarView.add_top_bar(headerBar)

        // Content
        const scrolled = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vexpand: true,
        })

        this.#listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
            margin_start: 12,
            margin_end: 12,
            margin_top: 12,
            margin_bottom: 12,
        })

        scrolled.set_child(this.#listBox)
        toolbarView.set_content(scrolled)

        this.#loadSessions()
    }

    #loadSessions() {
        // Clear existing rows
        let child = this.#listBox.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            this.#listBox.remove(child)
            child = next
        }

        const sessions = chatHistoryManager.sessions

        if (sessions.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: _('No Chat History'),
                subtitle: _('Your conversations will appear here'),
                sensitive: false,
            })
            emptyRow.add_prefix(new Gtk.Image({
                icon_name: 'user-available-symbolic',
                css_classes: ['dim-label'],
            }))
            this.#listBox.append(emptyRow)
            return
        }

        for (const session of sessions) {
            const row = this.#createSessionRow(session)
            this.#listBox.append(row)
        }
    }

    #createSessionRow(session) {
        const row = new Adw.ActionRow({
            title: session.title || _('Untitled Chat'),
            subtitle: this.#formatDate(session.updated),
            activatable: true,
        })

        // Book title badge if available
        if (session.book_title) {
            row.add_suffix(new Gtk.Label({
                label: session.book_title,
                css_classes: ['caption', 'dim-label'],
                ellipsize: 3, // PANGO_ELLIPSIZE_END
                max_width_chars: 15,
            }))
        }

        // Message count
        const countLabel = new Gtk.Label({
            label: `${session.messages.length}`,
            css_classes: ['caption', 'dim-label'],
            tooltip_text: _('Messages'),
        })
        row.add_suffix(countLabel)

        // Delete button
        const deleteButton = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'],
            tooltip_text: _('Delete'),
        })
        deleteButton.connect('clicked', () => {
            chatHistoryManager.deleteSession(session.id)
            this.#loadSessions()
        })
        row.add_suffix(deleteButton)

        // Load session on click
        row.connect('activated', () => {
            this.emit('session-selected', session.id)
            this.close()
        })

        return row
    }

    #formatDate(isoString) {
        try {
            const date = new Date(isoString)
            const now = new Date()
            const diff = now - date

            // Today
            if (diff < 24 * 60 * 60 * 1000 && date.getDate() === now.getDate()) {
                return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
            }
            // Yesterday
            if (diff < 48 * 60 * 60 * 1000) {
                return _('Yesterday')
            }
            // This week
            if (diff < 7 * 24 * 60 * 60 * 1000) {
                return date.toLocaleDateString(undefined, { weekday: 'long' })
            }
            // Older
            return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        } catch {
            return ''
        }
    }

    #confirmClearAll() {
        const dialog = new Adw.AlertDialog({
            heading: _('Clear All History?'),
            body: _('This will permanently delete all chat conversations.'),
        })
        dialog.add_response('cancel', _('Cancel'))
        dialog.add_response('clear', _('Clear All'))
        dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.connect('response', (_, response) => {
            if (response === 'clear') {
                chatHistoryManager.clearAllSessions()
                this.#loadSessions()
            }
        })
        dialog.present(this)
    }
})

// AI Model configuration class
export const AIModel = GObject.registerClass({
    GTypeName: 'FoliateAIModel',
    Properties: utils.makeParams({
        'id': 'string',
        'name': 'string',
        'endpoint': 'string',
        'api-key': 'string',
        'model-identifier': 'string',
        'is-default': 'boolean',
    }),
}, class extends GObject.Object {
    constructor(params) {
        super(params)
        if (!this.id) {
            this.id = GLib.uuid_string_random()
        }
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            endpoint: this.endpoint,
            apiKey: this.api_key,
            modelIdentifier: this.model_identifier,
            isDefault: this.is_default,
        }
    }

    static fromJSON(obj) {
        return new AIModel({
            id: obj.id,
            name: obj.name,
            endpoint: obj.endpoint,
            api_key: obj.apiKey,
            model_identifier: obj.modelIdentifier,
            is_default: obj.isDefault,
        })
    }
})

// AI Models Manager - handles model storage and retrieval
export class AIModelsManager {
    #settings
    #storage
    #models = []

    constructor() {
        this.#settings = utils.settings('ai')
        if (!this.#settings) {
            // Fallback to file storage if settings schema is missing
            const path = GLib.build_filenamev([GLib.get_user_data_dir(), pkg.name])
            GLib.mkdir_with_parents(path, 0o755)
            this.#storage = new utils.JSONStorage(path, 'ai-models', 2)
        }
        this.#loadModels()
    }

    #loadModels() {
        try {
            let data = []
            if (this.#settings) {
                const json = this.#settings.get_string('models')
                data = JSON.parse(json)
            } else if (this.#storage) {
                data = this.#storage.get('models', [])
            }
            this.#models = data.map(m => AIModel.fromJSON(m))
        } catch (e) {
            console.error('Failed to load AI models:', e)
            this.#models = []
        }
    }

    #saveModels() {
        try {
            const rawData = this.#models.map(m => m.toJSON())
            if (this.#settings) {
                const json = JSON.stringify(rawData)
                this.#settings.set_string('models', json)
            } else if (this.#storage) {
                this.#storage.set('models', rawData)
            }
        } catch (e) {
            console.error('Failed to save AI models:', e)
        }
    }

    get models() {
        return this.#models
    }

    getModel(id) {
        return this.#models.find(m => m.id === id)
    }

    getDefaultModel() {
        let defaultId
        if (this.#settings) {
            defaultId = this.#settings.get_string('default-model')
        } else if (this.#storage) {
            defaultId = this.#storage.get('default-model')
        }

        if (defaultId) {
            const model = this.getModel(defaultId)
            if (model) return model
        }
        return this.#models.find(m => m.is_default) ?? this.#models[0]
    }

    setDefaultModel(id) {
        if (this.#settings) {
            this.#settings.set_string('default-model', id)
        } else if (this.#storage) {
            this.#storage.set('default-model', id)
        }

        // Update is_default flags
        for (const model of this.#models) {
            model.is_default = model.id === id
        }
        this.#saveModels()
    }

    addModel(model) {
        this.#models.push(model)
        if (this.#models.length === 1) {
            model.is_default = true
        }
        this.#saveModels()
    }

    updateModel(id, updates) {
        const model = this.getModel(id)
        if (model) {
            Object.assign(model, updates)
            this.#saveModels()
        }
    }

    deleteModel(id) {
        const index = this.#models.findIndex(m => m.id === id)
        if (index !== -1) {
            this.#models.splice(index, 1)
            this.#saveModels()
        }
    }
}

// Create singleton instance
export const aiModelsManager = new AIModelsManager()

// AI Chat Service - handles API communication
export class AIChatService {
    #session

    constructor() {
        this.#session = new Soup.Session({
            user_agent: 'Foliate/1.0',
            timeout: 60,
        })
    }

    async sendMessage(model, messages, documentContext = null) {
        if (!model) {
            throw new Error(_('No AI model configured'))
        }

        const apiMessages = []

        // Add system message with document context if available
        if (documentContext) {
            apiMessages.push({
                role: 'system',
                content: `You are a helpful AI assistant for an e-book reader application. The user is currently reading a document. Here is the relevant context from the document they are viewing:\n\n---\n${documentContext}\n---\n\nPlease use this context to help answer questions about the document or provide relevant assistance. If the question is not related to the document, you can still help with general questions.`,
            })
        } else {
            apiMessages.push({
                role: 'system',
                content: 'You are a helpful AI assistant for an e-book reader application. Help the user with their questions about reading, books, or any other topics they ask about.',
            })
        }

        // Add conversation history
        for (const msg of messages) {
            if (msg.role !== 'system') {
                apiMessages.push({
                    role: msg.role,
                    content: msg.content,
                })
            }
        }

        const requestBody = {
            model: model.model_identifier || 'gpt-3.5-turbo',
            messages: apiMessages,
            temperature: 0.7,
            max_tokens: 2048,
        }

        let endpoint = model.endpoint
        if (!endpoint.endsWith('/chat/completions')) {
            if (!endpoint.endsWith('/')) {
                endpoint += '/'
            }
            endpoint += 'chat/completions'
        }

        const message = Soup.Message.new('POST', endpoint)
        if (!message) {
            throw new Error(_('Invalid API endpoint URL'))
        }

        // Set headers
        message.request_headers.append('Content-Type', 'application/json')
        message.request_headers.append('Authorization', `Bearer ${model.api_key}`)

        // Set request body
        const requestData = JSON.stringify(requestBody)
        message.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(requestData)),
        )

        // Send request
        return new Promise((resolve, reject) => {
            this.#session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result)
                        const statusCode = message.get_status()

                        if (statusCode !== 200) {
                            const errorText = new TextDecoder().decode(bytes.get_data())
                            try {
                                const errorJson = JSON.parse(errorText)
                                reject(new Error(errorJson.error?.message || `API Error: ${statusCode}`))
                            } catch {
                                reject(new Error(`API Error: ${statusCode}`))
                            }
                            return
                        }

                        const responseText = new TextDecoder().decode(bytes.get_data())
                        const response = JSON.parse(responseText)

                        const assistantMessage = response.choices?.[0]?.message?.content
                        if (assistantMessage) {
                            resolve(assistantMessage)
                        } else {
                            reject(new Error(_('Invalid response from AI')))
                        }
                    } catch (e) {
                        reject(e)
                    }
                },
            )
        })
    }

    async testConnection(model) {
        const testMessages = [{
            role: 'user',
            content: 'Hello, please respond with "Connection successful" to confirm the API is working.',
        }]

        try {
            await this.sendMessage(model, testMessages)
            return { success: true, message: _('Connection successful') }
        } catch (e) {
            return { success: false, message: e.message }
        }
    }

    cancel() {
        this.#session.abort()
    }
}

// Create singleton instance
export const aiChatService = new AIChatService()

// Main AI Chat Panel Widget
let cssLoaded = false
export const AIChatPanel = GObject.registerClass({
    GTypeName: 'FoliateAIChatPanelFixed',
    Template: Gio.File.new_for_uri(import.meta.url).get_parent().get_child('ui').get_child('ai-chat-panel.ui').get_uri(),
    Properties: utils.makeParams({
        'visible-panel': 'boolean',
        'document-context': 'string',
        'book-title': 'string',
    }),
    Signals: {
        'toggle-panel': {},
        'open-settings': {},
        'close': {},
        'request-chapter-context': {},
        'request-page-context': {},
    },
    InternalChildren: [
        'header-box',
        'chat-list', 'message-view', 'send-button',
        'new-chat-button', 'history-button',
        'loading-spinner', 'status-label',
        'model-label', 'scroll-window',
        'include-chapter-button', 'include-page-button',
        'context-revealer', 'context-label', 'clear-context-button',
        'input-frame', 'input-toolbar', 'send-hint-label',
    ],
}, class extends Gtk.Box {
    #messages = []
    #settings
    #chatService
    #currentSession = null
    #manualContext = null

    #webView
    #ready

    get headerBox() {
        return this._header_box
    }

    constructor(params) {
        super(params)

        if (!cssLoaded) {
            const provider = new Gtk.CssProvider()
            provider.load_from_data(`
                /* Chat input area styling - Native Adwaita look */
                .chat-input-area {
                    background: transparent;
                }
                
                .chat-input-frame {
                    background-color: @view_bg_color;
                    border-radius: 8px;
                    border: 1px solid alpha(@borders, 0.7);
                }
                
                .chat-input-frame:focus-within {
                    border-color: @accent_bg_color;
                    box-shadow: 0 0 0 2px alpha(@accent_bg_color, 0.2);
                }
                
                .chat-input-text {
                    background: transparent;
                    caret-color: @accent_bg_color;
                }
                
                .context-button {
                    min-width: 28px;
                    min-height: 28px;
                    padding: 4px;
                    opacity: 0.7;
                }
                
                .context-button:hover {
                    opacity: 1;
                    background-color: alpha(@accent_bg_color, 0.15);
                }
                
                .context-button.active {
                    color: @accent_bg_color;
                    opacity: 1;
                }
                
                .context-indicator {
                    background-color: alpha(@accent_bg_color, 0.1);
                    border-radius: 6px;
                    padding: 4px 8px;
                }
            `, -1)
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(),
                provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
            )
            cssLoaded = true
        }

        this.#settings = utils.settings('ai')
        this.#chatService = aiChatService

        // Replace scroll-window with WebView
        const prevSibling = this._scroll_window.get_prev_sibling()
        this.remove(this._scroll_window)

        this.#webView = new WebView({
            visible: true,
            hexpand: true,
            vexpand: true,
        })
        this.insert_child_after(this.#webView, prevSibling)

        this.#ready = this.#webView.loadHTML(CHAT_HTML, 'foliate:///ai-chat/')

        // Inject marked.js library
        this.#ready = this.#ready.then(() => {
            try {
                const markedFile = Gio.File.new_for_uri(pkg.moduleuri('/vendor/marked.js'))
                const [, contents] = markedFile.load_contents(null)
                const markedCode = new TextDecoder().decode(contents)
                return this.#webView.run(markedCode)
            } catch (e) {
                console.error('Failed to load marked.js:', e)
            }
        })

        // Inject colors
        const context = this.get_style_context()
        const [hasBg, bgColor] = context.lookup_color('accent_bg_color')
        const [hasFg, fgColor] = context.lookup_color('accent_fg_color')

        if (hasBg || hasFg) {
            let css = ':root {'
            if (hasBg) css += `--user-bg: ${bgColor.to_string()};`
            if (hasFg) css += `--user-fg: ${fgColor.to_string()};`
            css += '}'
            this.#ready = this.#ready.then(() =>
                this.#webView.run(`
                    const style = document.createElement('style');
                    style.textContent = \`${css}\`;
                    document.head.appendChild(style);
                `)
            )
        }

        // Connect signals
        this._send_button.connect('clicked', () => this.#sendMessage())
        this._new_chat_button.connect('clicked', () => this.#startNewChat())
        this._history_button.connect('clicked', () => this.#showHistoryDialog())

        // Context buttons
        this._include_chapter_button.connect('clicked', () => {
            this.emit('request-chapter-context')
        })
        this._include_page_button.connect('clicked', () => {
            this.emit('request-page-context')
        })
        this._clear_context_button.connect('clicked', () => {
            this.#clearManualContext()
        })

        // Key handling: Enter for new line, Ctrl+Enter to send
        const keyController = new Gtk.EventControllerKey()
        keyController.connect('key-pressed', (_, keyval, keycode, state) => {
            if (keyval === 65293 || keyval === 65421) { // Return or KP_Enter
                if (state & Gdk.ModifierType.CONTROL_MASK) {
                    // Ctrl+Enter to send
                    this.#sendMessage()
                    return true
                }
                // Plain Enter inserts new line (default behavior)
                return false
            }
            return false
        })
        this._message_view.add_controller(keyController)

        // Update model label
        this.#updateModelLabel()

        // Start with a new session
        this.#startNewChat()
    }

    #clearManualContext() {
        this.#manualContext = null
        this._context_revealer.reveal_child = false
        this._include_chapter_button.remove_css_class('active')
        this._include_page_button.remove_css_class('active')
    }

    setManualContext(text, type) {
        if (!text || text.trim().length === 0) {
            this.#clearManualContext()
            return
        }

        this.#manualContext = text.trim()

        // Update context indicator
        if (type === 'chapter') {
            this._context_label.label = _('Chapter context attached')
            this._include_chapter_button.add_css_class('active')
            this._include_page_button.remove_css_class('active')
        } else if (type === 'page') {
            this._context_label.label = _('Page context attached')
            this._include_page_button.add_css_class('active')
            this._include_chapter_button.remove_css_class('active')
        } else {
            this._context_label.label = _('Context attached')
        }

        this._context_revealer.reveal_child = true

        // Focus the input field
        this._message_view.grab_focus()
    }

    #startNewChat() {
        // Save current session if it has messages and assistant response
        if (this.#currentSession && this.#shouldSaveSession(this.#currentSession)) {
            chatHistoryManager.updateSession(this.#currentSession)
        }

        // Clear UI
        this.#clearChatUI()

        // Create new session
        this.#currentSession = chatHistoryManager.createSession(this.book_title)
        this.#messages = []
    }

    #showHistoryDialog() {
        const dialog = new ChatHistoryDialog()
        dialog.connect('session-selected', (_, sessionId) => {
            this.#loadSession(sessionId)
        })
        dialog.present(this.get_root())
    }

    async #loadSession(sessionId) {
        const session = chatHistoryManager.getSession(sessionId)
        if (!session) return

        // Save current session first
        if (this.#currentSession && this.#shouldSaveSession(this.#currentSession)) {
            chatHistoryManager.updateSession(this.#currentSession)
        }

        // Clear current UI
        await this.#clearChatUI()

        // Load the selected session
        this.#currentSession = session
        this.#messages = []

        // Restore messages to UI
        await this.#ready
        for (const msg of session.messages) {
            this.#messages.push(msg)
            const content = JSON.stringify(msg.content)
            const role = msg.role
            const isError = msg.is_error
            this.#webView.run(`addMessage('${role}', ${content}, ${isError})`)
        }
    }

    async #clearChatUI() {
        await this.#ready
        this.#webView.run('clearMessages()')
        this._status_label.visible = false
    }

    #updateModelLabel() {
        const model = aiModelsManager.getDefaultModel()
        if (model) {
            this._model_label.label = model.name
            this._model_label.visible = true
        } else {
            this._model_label.label = _('No model configured')
            this._model_label.visible = true
        }
    }

    async #sendMessage() {
        const buffer = this._message_view.buffer
        const [start, end] = buffer.get_bounds()
        const text = buffer.get_text(start, end, true).trim()
        if (!text) return

        const model = aiModelsManager.getDefaultModel()
        if (!model) {
            this.#showError(_('No AI model configured. Please add a model in settings.'))
            return
        }

        // Clear input
        buffer.text = ''

        // Add user message
        const userMessage = new AIMessage({
            role: 'user',
            content: text,
        })
        this.#addMessage(userMessage)

        // Show loading state
        this.#setLoading(true)

        try {
            // Get context: prefer manual context, fallback to auto context
            let context = null
            if (this.#manualContext) {
                // Use manually included context (chapter or page)
                const maxLength = this.#settings?.get_int('context-length') ?? 8000
                context = this.#manualContext.substring(0, maxLength)
                // Clear manual context after use
                this.#clearManualContext()
            } else if (this.#settings?.get_boolean('include-context') && this.document_context) {
                // Use auto context from visible page
                const maxLength = this.#settings.get_int('context-length')
                context = this.document_context.substring(0, maxLength)
            }

            // Prepare message history for API
            const history = this.#messages.map(m => ({
                role: m.role,
                content: m.content,
            }))

            // Send to AI
            const response = await this.#chatService.sendMessage(model, history, context)

            // Add assistant response
            const assistantMessage = new AIMessage({
                role: 'assistant',
                content: response,
            })
            this.#addMessage(assistantMessage)

            // Generate title if needed
            if (this.#currentSession && !this.#currentSession.title) {
                const firstUserMessage = this.#messages.find(m => m.role === 'user')
                if (firstUserMessage) {
                    this.#generateTitle(firstUserMessage.content)
                }
            }

        } catch (e) {
            this.#showError(e.message)
        } finally {
            this.#setLoading(false)
        }
    }

    async #generateTitle(userContent) {
        const model = aiModelsManager.getDefaultModel()
        if (!model) return

        try {
            const messages = [{
                role: 'user',
                content: `Generate a short, concise title (max 5 words) for this conversation query. Do not use quotes. \n\nQuery: "${userContent}"`
            }]

            // Generate title without document context
            const title = await this.#chatService.sendMessage(model, messages, null)

            if (title && this.#currentSession) {
                this.#currentSession.title = title.replace(/^["']|["']$/g, '').trim()
                if (this.#shouldSaveSession(this.#currentSession)) {
                    chatHistoryManager.updateSession(this.#currentSession)
                }
            }
        } catch (e) {
            console.warn('Failed to generate chat title:', e)
        }
    }

    async #addMessage(message) {
        this.#messages.push(message)

        // Save to session
        if (this.#currentSession) {
            this.#currentSession.addMessage(message)
            if (this.#shouldSaveSession(this.#currentSession)) {
                chatHistoryManager.updateSession(this.#currentSession)
            }
        }

        // Add to WebView
        await this.#ready
        const content = JSON.stringify(message.content)
        const role = message.role
        const isError = message.is_error
        this.#webView.run(`addMessage('${role}', ${content}, ${isError})`)
    }



    #showError(message) {
        const errorMessage = new AIMessage({
            role: 'assistant',
            content: `Error: ${message}`,
            is_error: true,
        })
        this.#addMessage(errorMessage)
    }

    #setLoading(loading) {
        this._loading_spinner.visible = loading
        this._loading_spinner.spinning = loading
        this._send_button.sensitive = !loading
        this._message_view.sensitive = !loading

        if (loading) {
            this._status_label.label = _('AI is thinking…')
            this._status_label.visible = true
        } else {
            this._status_label.visible = false
        }
    }

    setupHeaderWidgets(menu, fullscreen) {
        this._header_box.insert_child_after(menu, this._history_button)
        this._header_box.insert_child_after(fullscreen, menu)
    }

    clearChat() {
        this.#startNewChat()
    }

    refreshModelLabel() {
        this.#updateModelLabel()
    }

    setDocumentContext(text) {
        this.document_context = text
    }

    setBookTitle(title) {
        this.book_title = title
        // Update current session's book title if session exists and has no messages yet
        if (this.#currentSession && this.#messages.length === 0) {
            this.#currentSession.book_title = title
            // Don't save yet
        }
    }

    #shouldSaveSession(session) {
        return session && session.messages.some(m => m.role === 'assistant')
    }

    setInputText(text) {
        // Set the text in the input field
        this._message_view.buffer.text = text
        // Focus the input field
        this._message_view.grab_focus()
        // Position cursor at the end
        const buffer = this._message_view.buffer
        const iter = buffer.get_end_iter()
        buffer.place_cursor(iter)
    }
})
