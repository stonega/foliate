import Gtk from 'gi://Gtk'
import Adw from 'gi://Adw'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Gdk from 'gi://Gdk'
import Soup from 'gi://Soup'
import { gettext as _ } from 'gettext'

import * as utils from './utils.js'

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
        if (!this.title && message.role === 'user') {
            this.title = message.content.substring(0, 50) + (message.content.length > 50 ? '…' : '')
        }
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
        this.#sessions.unshift(session)
        this.#saveSessions()
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
            this.#saveSessions()
        }
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
                icon_name: 'chat-symbolic',
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
    #models = []

    constructor() {
        this.#settings = utils.settings('ai')
        this.#loadModels()
    }

    #loadModels() {
        try {
            const json = this.#settings?.get_string('models') ?? '[]'
            const data = JSON.parse(json)
            this.#models = data.map(m => AIModel.fromJSON(m))
        } catch (e) {
            console.error('Failed to load AI models:', e)
            this.#models = []
        }
    }

    #saveModels() {
        try {
            const json = JSON.stringify(this.#models.map(m => m.toJSON()))
            this.#settings?.set_string('models', json)
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
        const defaultId = this.#settings?.get_string('default-model')
        if (defaultId) {
            const model = this.getModel(defaultId)
            if (model) return model
        }
        return this.#models.find(m => m.is_default) ?? this.#models[0]
    }

    setDefaultModel(id) {
        this.#settings?.set_string('default-model', id)
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

        const message = Soup.Message.new('POST', model.endpoint)
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
export const AIChatPanel = GObject.registerClass({
    GTypeName: 'FoliateAIChatPanel',
    Template: pkg.moduleuri('ui/ai-chat-panel.ui'),
    Properties: utils.makeParams({
        'visible-panel': 'boolean',
        'document-context': 'string',
        'book-title': 'string',
    }),
    Signals: {
        'toggle-panel': {},
        'open-settings': {},
    },
    InternalChildren: [
        'chat-list', 'message-entry', 'send-button',
        'new-chat-button', 'settings-button', 'history-button',
        'loading-spinner', 'status-label',
        'model-label', 'scroll-window',
    ],
}, class extends Gtk.Box {
    #messages = []
    #settings
    #chatService
    #currentSession = null

    constructor(params) {
        super(params)
        this.#settings = utils.settings('ai')
        this.#chatService = aiChatService

        // Setup message list
        this._chat_list.set_selection_mode(Gtk.SelectionMode.NONE)

        // Connect signals
        this._send_button.connect('clicked', () => this.#sendMessage())
        this._new_chat_button.connect('clicked', () => this.#startNewChat())
        this._settings_button.connect('clicked', () => this.emit('open-settings'))
        this._history_button.connect('clicked', () => this.#showHistoryDialog())

        // Entry key handling
        this._message_entry.connect('activate', () => this.#sendMessage())

        // Multi-line support with Ctrl+Enter to send
        const keyController = new Gtk.EventControllerKey()
        keyController.connect('key-pressed', (_, keyval, keycode, state) => {
            if (keyval === 65293) { // Return key
                if (state & Gdk.ModifierType.SHIFT_MASK) {
                    // Allow Shift+Enter for new line
                    return false
                }
                this.#sendMessage()
                return true
            }
            return false
        })
        this._message_entry.add_controller(keyController)

        // Update model label
        this.#updateModelLabel()

        // Start with a new session
        this.#startNewChat()
    }

    #startNewChat() {
        // Save current session if it has messages
        if (this.#currentSession && this.#messages.length > 0) {
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

    #loadSession(sessionId) {
        const session = chatHistoryManager.getSession(sessionId)
        if (!session) return

        // Save current session first
        if (this.#currentSession && this.#messages.length > 0) {
            chatHistoryManager.updateSession(this.#currentSession)
        }

        // Clear current UI
        this.#clearChatUI()

        // Load the selected session
        this.#currentSession = session
        this.#messages = []

        // Restore messages to UI
        for (const msg of session.messages) {
            this.#messages.push(msg)
            const row = this.#createMessageRow(msg)
            this._chat_list.append(row)
        }

        // Scroll to bottom
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const adj = this._scroll_window.vadjustment
            adj.value = adj.upper - adj.page_size
            return false
        })
    }

    #clearChatUI() {
        // Remove all children from chat list
        let child = this._chat_list.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            this._chat_list.remove(child)
            child = next
        }
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
        const text = this._message_entry.text.trim()
        if (!text) return

        const model = aiModelsManager.getDefaultModel()
        if (!model) {
            this.#showError(_('No AI model configured. Please add a model in settings.'))
            return
        }

        // Clear input
        this._message_entry.text = ''

        // Add user message
        const userMessage = new AIMessage({
            role: 'user',
            content: text,
        })
        this.#addMessage(userMessage)

        // Show loading state
        this.#setLoading(true)

        try {
            // Get document context if enabled
            let context = null
            if (this.#settings?.get_boolean('include-context') && this.document_context) {
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

        } catch (e) {
            this.#showError(e.message)
        } finally {
            this.#setLoading(false)
        }
    }

    #addMessage(message) {
        this.#messages.push(message)

        // Save to session
        if (this.#currentSession) {
            this.#currentSession.addMessage(message)
            chatHistoryManager.updateSession(this.#currentSession)
        }

        // Create message row
        const row = this.#createMessageRow(message)
        this._chat_list.append(row)

        // Scroll to bottom
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const adj = this._scroll_window.vadjustment
            adj.value = adj.upper - adj.page_size
            return false
        })
    }

    #createMessageRow(message) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_start: 12,
            margin_end: 12,
            margin_top: 6,
            margin_bottom: 6,
        })

        const isUser = message.role === 'user'
        const isError = message.is_error

        // Role label
        const roleLabel = new Gtk.Label({
            label: isUser ? _('You') : _('AI Assistant'),
            xalign: isUser ? 1 : 0,
            css_classes: ['caption', 'dim-label'],
            margin_bottom: 4,
        })
        row.append(roleLabel)

        // Message content box
        const contentBox = new Gtk.Box({
            css_classes: ['card', isError ? 'error-message' : (isUser ? 'user-message' : 'assistant-message')],
            halign: isUser ? Gtk.Align.END : Gtk.Align.START,
        })

        const contentLabel = new Gtk.Label({
            label: message.content,
            wrap: true,
            wrap_mode: 2, // WORD_CHAR
            xalign: 0,
            selectable: true,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
            max_width_chars: 50,
        })
        contentBox.append(contentLabel)
        row.append(contentBox)

        return row
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
        this._message_entry.sensitive = !loading

        if (loading) {
            this._status_label.label = _('AI is thinking…')
            this._status_label.visible = true
        } else {
            this._status_label.visible = false
        }
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
            chatHistoryManager.updateSession(this.#currentSession)
        }
    }

    setInputText(text) {
        // Set the text in the input field
        this._message_entry.text = text
        // Focus the input field
        this._message_entry.grab_focus()
        // Position cursor at the end
        this._message_entry.set_position(-1)
    }
})
