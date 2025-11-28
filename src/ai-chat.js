import Gtk from 'gi://Gtk'
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
    }),
    Signals: {
        'toggle-panel': {},
        'open-settings': {},
    },
    InternalChildren: [
        'chat-list', 'message-entry', 'send-button',
        'new-chat-button', 'settings-button',
        'loading-spinner', 'status-label',
        'model-label', 'scroll-window',
    ],
}, class extends Gtk.Box {
    #messages = []
    #settings
    #chatService

    constructor(params) {
        super(params)
        this.#settings = utils.settings('ai')
        this.#chatService = aiChatService

        // Setup message list
        this._chat_list.set_selection_mode(Gtk.SelectionMode.NONE)

        // Connect signals
        this._send_button.connect('clicked', () => this.#sendMessage())
        this._new_chat_button.connect('clicked', () => this.clearChat())
        this._settings_button.connect('clicked', () => this.emit('open-settings'))

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
        this.#messages = []
        // Remove all children from chat list
        let child = this._chat_list.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            this._chat_list.remove(child)
            child = next
        }
        this._status_label.visible = false
    }

    refreshModelLabel() {
        this.#updateModelLabel()
    }

    setDocumentContext(text) {
        this.document_context = text
    }
})
