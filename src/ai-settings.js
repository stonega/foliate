import Gtk from 'gi://Gtk'
import Adw from 'gi://Adw'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import GObject from 'gi://GObject'
import { gettext as _ } from 'gettext'

import * as utils from './utils.js'
import { locales } from './format.js'
import { AIModel, aiModelsManager, aiChatService } from './ai-chat.js'

export const explainLanguages = [
    ['en', 'English'],
    ['zh-Hans', 'Simplified Chinese'],
    ['zh-Hant', 'Traditional Chinese'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['pt', 'Portuguese'],
    ['ru', 'Russian'],
    ['ar', 'Arabic'],
    ['hi', 'Hindi'],
    ['it', 'Italian'],
    ['nl', 'Dutch'],
    ['tr', 'Turkish'],
    ['vi', 'Vietnamese'],
    ['id', 'Indonesian'],
]

export const getExplainLanguageName = code =>
    explainLanguages.find(([languageCode]) => languageCode === code)?.[1]
        ?? explainLanguages[0][1]

export const setupExplainLanguageRow = (row, settings) => {
    const displayNames = new Intl.DisplayNames(locales, { type: 'language' })
    const model = new Gtk.StringList()
    for (const [code] of explainLanguages)
        model.append(displayNames.of(code) ?? code)
    row.model = model

    if (!settings) {
        row.sensitive = false
        return
    }

    const language = settings.get_string('explain-language')
    const index = explainLanguages.findIndex(([code]) => code === language)
    row.selected = index >= 0 ? index : 0
    row.connect('notify::selected', () => {
        const code = explainLanguages[row.selected]?.[0]
        if (code && settings.get_string('explain-language') !== code)
            settings.set_string('explain-language', code)
    })
}

// Individual model row widget
export const AIModelRow = GObject.registerClass({
    GTypeName: 'FoliateAIModelRow',
    Signals: {
        'edit-model': { param_types: [GObject.TYPE_JSOBJECT] },
        'delete-model': { param_types: [GObject.TYPE_STRING] },
        'set-default': { param_types: [GObject.TYPE_STRING] },
    },
}, class extends Adw.ActionRow {
    #model

    constructor(model) {
        super({
            title: model.name,
            subtitle: model.endpoint,
            activatable: true,
        })
        this.#model = model

        // Default indicator
        if (model.is_default) {
            const defaultBadge = new Gtk.Label({
                label: _('Default'),
                css_classes: ['caption', 'accent'],
                valign: Gtk.Align.CENTER,
                margin_end: 8,
            })
            this.add_suffix(defaultBadge)
        }

        // Edit button
        const editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'],
            tooltip_text: _('Edit Model'),
        })
        editButton.connect('clicked', () => {
            this.emit('edit-model', this.#model)
        })
        this.add_suffix(editButton)

        // Menu button for more actions
        const menuButton = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'],
            tooltip_text: _('More Options'),
        })

        const menu = new Gio.Menu()
        menu.append(_('Set as Default'), `model.set-default::${model.id}`)
        menu.append(_('Delete'), `model.delete::${model.id}`)
        menuButton.menu_model = menu
        this.add_suffix(menuButton)

        // Setup actions
        const actionGroup = new Gio.SimpleActionGroup()

        const setDefaultAction = new Gio.SimpleAction({
            name: 'set-default',
            parameter_type: GLib.VariantType.new('s'),
        })
        setDefaultAction.connect('activate', (_, param) => {
            this.emit('set-default', param.get_string()[0])
        })
        actionGroup.add_action(setDefaultAction)

        const deleteAction = new Gio.SimpleAction({
            name: 'delete',
            parameter_type: GLib.VariantType.new('s'),
        })
        deleteAction.connect('activate', (_, param) => {
            this.emit('delete-model', param.get_string()[0])
        })
        actionGroup.add_action(deleteAction)

        this.insert_action_group('model', actionGroup)
    }

    get model() {
        return this.#model
    }
})

// Model editor dialog
export const AIModelEditorDialog = GObject.registerClass({
    GTypeName: 'FoliateAIModelEditorDialog',
    Template: pkg.moduleuri('ui/ai-model-editor.ui'),
    InternalChildren: [
        'name-entry', 'endpoint-entry', 'api-key-entry',
        'model-id-entry', 'default-switch',
        'test-button', 'test-spinner', 'test-status',
        'save-button', 'reveal-button',
    ],
}, class extends Adw.Dialog {
    #model = null
    #isNew = true
    #passwordVisible = false

    constructor(params) {
        super(params)

        // Connect signals
        this._test_button.connect('clicked', () => this.#testConnection())
        this._save_button.connect('clicked', () => this.#save())

        // Start with hidden password (using input hints)
        this.#passwordVisible = false
        this.#updatePasswordVisibility()

        // Password reveal toggle
        this._reveal_button.connect('clicked', () => {
            this.#passwordVisible = !this.#passwordVisible
            this.#updatePasswordVisibility()
        })

        // Validation on input change
        const validateInputs = () => this.#validateInputs()
        this._name_entry.connect('changed', validateInputs)
        this._endpoint_entry.connect('changed', validateInputs)
        this._api_key_entry.connect('changed', validateInputs)
    }

    loadModel(model) {
        this.#model = model
        this.#isNew = false

        this._name_entry.text = model.name || ''
        this._endpoint_entry.text = model.endpoint || ''
        this._api_key_entry.text = model.api_key || ''
        this._model_id_entry.text = model.model_identifier || ''
        this._default_switch.active = model.is_default || false

        this.#validateInputs()
    }

    #updatePasswordVisibility() {
        // AdwEntryRow uses input-purpose for password masking
        // We'll toggle by adding/removing the password style
        if (this.#passwordVisible) {
            this._api_key_entry.input_purpose = Gtk.InputPurpose.FREE_FORM
            this._reveal_button.icon_name = 'view-conceal-symbolic'
        } else {
            this._api_key_entry.input_purpose = Gtk.InputPurpose.PASSWORD
            this._reveal_button.icon_name = 'view-reveal-symbolic'
        }
    }

    #validateInputs() {
        const name = this._name_entry.text.trim()
        const endpoint = this._endpoint_entry.text.trim()
        const apiKey = this._api_key_entry.text.trim()

        const isValid = name.length > 0 && endpoint.length > 0 && apiKey.length > 0
        this._save_button.sensitive = isValid
        this._test_button.sensitive = isValid
    }

    async #testConnection() {
        const model = this.#buildModel()

        this._test_spinner.visible = true
        this._test_spinner.spinning = true
        this._test_button.sensitive = false
        this._test_status.label = _('Testing connection…')
        this._test_status.visible = true
        this._test_status.remove_css_class('success')
        this._test_status.remove_css_class('error')

        try {
            const result = await aiChatService.testConnection(model)

            if (result.success) {
                this._test_status.label = _('✓ Connection successful')
                this._test_status.add_css_class('success')
            } else {
                this._test_status.label = `✗ ${result.message}`
                this._test_status.add_css_class('error')
            }
        } catch (e) {
            this._test_status.label = `✗ ${e.message}`
            this._test_status.add_css_class('error')
        } finally {
            this._test_spinner.visible = false
            this._test_spinner.spinning = false
            this._test_button.sensitive = true
        }
    }

    #buildModel() {
        const params = {
            name: this._name_entry.text.trim(),
            endpoint: this._endpoint_entry.text.trim(),
            api_key: this._api_key_entry.text.trim(),
            model_identifier: this._model_id_entry.text.trim(),
            is_default: this._default_switch.active,
        }
        if (this.#model?.id) {
            params.id = this.#model.id
        }
        return new AIModel(params)
    }

    #save() {
        const model = this.#buildModel()

        if (this.#isNew) {
            aiModelsManager.addModel(model)
        } else {
            aiModelsManager.updateModel(model.id, {
                name: model.name,
                endpoint: model.endpoint,
                api_key: model.api_key,
                model_identifier: model.model_identifier,
                is_default: model.is_default,
            })
            if (model.is_default) {
                aiModelsManager.setDefaultModel(model.id)
            }
        }

        this.close()
    }
})

// Main AI Settings Dialog
export const AISettingsDialog = GObject.registerClass({
    GTypeName: 'FoliateAISettingsDialog',
    Template: pkg.moduleuri('ui/ai-settings-dialog.ui'),
    InternalChildren: [
        'models-list', 'add-model-button',
        'include-context-switch', 'context-length-spin',
        'explain-language-row', 'send-on-enter-switch', 'empty-state',
    ],
}, class extends Adw.PreferencesDialog {
    #settings

    constructor(params) {
        super(params)
        this.#settings = utils.settings('ai')

        // Bind settings
        if (this.#settings) {
            this.#settings.bind('include-context', this._include_context_switch, 'active',
                Gio.SettingsBindFlags.DEFAULT)
            this.#settings.bind('context-length', this._context_length_spin, 'value',
                Gio.SettingsBindFlags.DEFAULT)
            this.#settings.bind('send-on-enter', this._send_on_enter_switch, 'active',
                Gio.SettingsBindFlags.DEFAULT)
        }
        setupExplainLanguageRow(this._explain_language_row, this.#settings)

        // Connect add button
        this._add_model_button.connect('clicked', () => this.#showModelEditor())

        // Load models
        this.#loadModels()
    }

    #loadModels() {
        // Clear existing rows
        let child = this._models_list.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            if (child instanceof AIModelRow) {
                this._models_list.remove(child)
            }
            child = next
        }

        const models = aiModelsManager.models

        // Show empty state or models list
        this._empty_state.visible = models.length === 0

        for (const model of models) {
            const row = new AIModelRow(model)
            row.connect('edit-model', (_, m) => this.#showModelEditor(m))
            row.connect('delete-model', (_, id) => this.#deleteModel(id))
            row.connect('set-default', (_, id) => this.#setDefaultModel(id))
            this._models_list.append(row)
        }
    }

    #showModelEditor(model = null) {
        const dialog = new AIModelEditorDialog()
        if (model) {
            dialog.loadModel(model)
        }
        dialog.connect('closed', () => this.#loadModels())
        dialog.present(this)
    }

    #deleteModel(id) {
        const dialog = new Adw.AlertDialog({
            heading: _('Delete Model?'),
            body: _('This action cannot be undone.'),
        })
        dialog.add_response('cancel', _('Cancel'))
        dialog.add_response('delete', _('Delete'))
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.connect('response', (_, response) => {
            if (response === 'delete') {
                aiModelsManager.deleteModel(id)
                this.#loadModels()
            }
        })
        dialog.present(this)
    }

    #setDefaultModel(id) {
        aiModelsManager.setDefaultModel(id)
        this.#loadModels()
    }
})
