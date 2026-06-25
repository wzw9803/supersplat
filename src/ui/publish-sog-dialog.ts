import { Button, Container, Label, TextAreaInput, TextInput } from '@playcanvas/pcui';
import { Events } from '../events';
import { localize } from './localization';
import { SogSettings } from '../splat-serialize';
import { uploadSogPackage, UploadFileState, UploadProgress } from '../sog-upload';

type PublishResult = {
    shareId: string;
    previewUrl: string;
};

enum DialogState {
    INPUT = 'input',
    UPLOADING = 'uploading',
    RESULT = 'result'
}

class PublishSogDialog extends Container {
    show: (sogSettings: SogSettings) => Promise<PublishResult | null>;
    hide: () => void;
    destroy: () => void;

    private _state: DialogState = DialogState.INPUT;
    private _contentInput: Container;
    private _nameInput: TextInput;
    private _descInput: TextAreaInput;
    private _confirmButton: Button;
    private _cancelButton: Button;
    private _contentUploading: Container;
    private _uploadStatusLabel: Label;
    private _fileProgressContainer: Container;
    private _cancelUploadButton: Button;
    private _contentResult: Container;
    private _resultLabel: Label;
    private _linkContainer: Container;
    private _linkLabel: Label;
    private _copyButton: Button;
    private _closeButton: Button;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'publish-sog-dialog',
            class: 'settings-dialog',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({ id: 'dialog' });

        // Header
        const header = new Container({ id: 'header' });
        const headerText = new Label({ id: 'text', text: localize('popup.publish-sog.header') });
        header.append(headerText);
        dialog.append(header);

        // Input state
        this._contentInput = new Container({ id: 'content' });

        const nameRow = new Container({ class: 'row' });
        const nameLabel = new Label({ class: 'label', text: localize('popup.publish-sog.name') });
        this._nameInput = new TextInput({ class: 'text-input' });
        nameRow.append(nameLabel);
        nameRow.append(this._nameInput);

        const descRow = new Container({ class: 'row' });
        const descLabel = new Label({ class: 'label', text: localize('popup.publish-sog.description') });
        this._descInput = new TextAreaInput({ class: 'text-area' });
        descRow.append(descLabel);
        descRow.append(this._descInput);

        this._contentInput.append(nameRow);
        this._contentInput.append(descRow);
        dialog.append(this._contentInput);

        // Uploading state
        this._contentUploading = new Container({ id: 'content-uploading', hidden: true });
        this._uploadStatusLabel = new Label({ class: 'upload-status', text: localize('popup.publish-sog.preparing') });
        this._fileProgressContainer = new Container({ class: 'file-progress-container' });
        this._contentUploading.append(this._uploadStatusLabel);
        this._contentUploading.append(this._fileProgressContainer);
        dialog.append(this._contentUploading);

        // Result state
        this._contentResult = new Container({ id: 'content-result', hidden: true });
        this._resultLabel = new Label({ class: 'result-label', text: localize('popup.publish-sog.success') });
        this._linkContainer = new Container({ class: 'link-row' });
        const linkLabelTitle = new Label({ class: 'label', text: localize('popup.publish-sog.preview-link') });
        this._linkLabel = new Label({ class: 'link-text' });
        this._copyButton = new Button({ class: 'button', text: localize('popup.publish-sog.copy-link') });
        this._linkContainer.append(linkLabelTitle);
        this._linkContainer.append(this._linkLabel);
        this._contentResult.append(this._resultLabel);
        this._contentResult.append(this._linkContainer);
        dialog.append(this._contentResult);

        // Footer
        const footer = new Container({ id: 'footer' });
        this._cancelButton = new Button({ class: 'button', text: localize('popup.cancel') });
        this._confirmButton = new Button({ class: 'button', text: localize('popup.publish-sog.confirm') });
        this._cancelUploadButton = new Button({ class: 'button', text: localize('popup.publish-sog.cancel-upload'), hidden: true });
        this._closeButton = new Button({ class: 'button', text: localize('popup.publish-sog.close'), hidden: true });

        footer.append(this._cancelButton);
        footer.append(this._confirmButton);
        footer.append(this._cancelUploadButton);
        footer.append(this._closeButton);
        footer.append(this._copyButton);
        this._copyButton.hidden = true;

        dialog.append(footer);
        this.append(dialog);

        // State management
        const setState = (state: DialogState) => {
            this._state = state;
            this._contentInput.hidden = state !== DialogState.INPUT;
            this._contentUploading.hidden = state !== DialogState.UPLOADING;
            this._contentResult.hidden = state !== DialogState.RESULT;
            this._cancelButton.hidden = state !== DialogState.INPUT;
            this._confirmButton.hidden = state !== DialogState.INPUT;
            this._cancelUploadButton.hidden = state !== DialogState.UPLOADING;
            this._closeButton.hidden = state !== DialogState.RESULT;
            this._copyButton.hidden = state !== DialogState.RESULT;
        };

        let cancelSignal: { aborted: boolean } | undefined;

        // Event handlers
        this._nameInput.on('change', () => {
            this._confirmButton.disabled = !this._nameInput.value.trim();
        });

        this._closeButton.on('click', () => {
            // Will be overridden per show() call
        });

        this._copyButton.on('click', () => {
            navigator.clipboard.writeText(this._linkLabel.text).then(() => {
                const orig = this._copyButton.text;
                this._copyButton.text = localize('popup.publish-sog.copy-success');
                setTimeout(() => {
                    this._copyButton.text = orig;
                }, 2000);
            }).catch(() => {
                // ignore clipboard errors
            });
        });

        // Methods
        this.show = (sogSettings: SogSettings) => {
            // Reset UI
            this._nameInput.value = '';
            this._descInput.value = '';
            this._confirmButton.disabled = true;
            this._uploadStatusLabel.text = localize('popup.publish-sog.preparing');
            this._fileProgressContainer.clear();
            this._linkLabel.text = '';
            this._resultLabel.text = localize('popup.publish-sog.success');
            setState(DialogState.INPUT);

            this.hidden = false;
            this.dom.focus();

            let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
            let publishResult: PublishResult | null = null;

            return new Promise<PublishResult | null>((resolve) => {
                const onCancel = () => {
                    if (cancelSignal) {
                        cancelSignal.aborted = true;
                        cancelSignal = undefined;
                    }
                    resolve(null);
                };

                // Close button in result state: resolve with stored result
                this._closeButton.on('click', () => {
                    if (this._state === DialogState.RESULT && publishResult) {
                        resolve(publishResult);
                    }
                });

                keydownHandler = (e: KeyboardEvent) => {
                    switch (e.key) {
                        case 'Escape':
                            if (this._state === DialogState.INPUT) onCancel();
                            break;
                        case 'Enter':
                            if (!e.shiftKey && this._state === DialogState.INPUT && !this._confirmButton.disabled) onConfirm();
                            break;
                        default:
                            e.stopPropagation();
                            break;
                    }
                };

                this.dom.addEventListener('keydown', keydownHandler);
                this._cancelButton.on('click', () => onCancel());

                const onConfirm = async () => {
                    const projectName = this._nameInput.value.trim();
                    if (!projectName) {
                        this._confirmButton.disabled = true;
                        return;
                    }

                    const splats = events.invoke('scene.splats');
                    if (!splats || splats.length === 0) return;

                    setState(DialogState.UPLOADING);
                    cancelSignal = { aborted: false };

                    this._cancelUploadButton.on('click', () => onCancel());

                    const onProgress = (progress: UploadProgress) => {
                        this._uploadStatusLabel.text = `${localize('popup.publish-sog.uploading')} (${progress.overallProgress}%)`;
                        this._renderFileProgress(progress.files);
                    };

                    try {
                        const result = await uploadSogPackage(
                            splats,
                            sogSettings,
                            projectName,
                            onProgress,
                            cancelSignal
                        );

                        cancelSignal = undefined;
                        // Show result page — stay open so user can copy the link
                        publishResult = result;
                        setState(DialogState.RESULT);
                        this._linkLabel.text = result.previewUrl;
                        // Do NOT resolve — user must click Close button
                    } catch (err) {
                        cancelSignal = undefined;
                        // Back to input state so user can retry
                        setState(DialogState.INPUT);
                        const msg = err instanceof Error ? err.message : String(err);
                        this._resultLabel.text = msg || localize('popup.publish-sog.failed');
                        // Do NOT resolve — user can retry or cancel
                    }
                };

                this._confirmButton.on('click', () => onConfirm());
            }).finally(() => {
                if (keydownHandler) {
                    this.dom.removeEventListener('keydown', keydownHandler);
                }
                this.hide();
            });
        };

        this.hide = () => {
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }

    private _renderFileProgress(files: UploadFileState[]) {
        this._fileProgressContainer.clear();
        for (const file of files) {
            const row = new Container({ class: 'file-progress-row' });

            const nameLabel = new Label({ class: 'file-name', text: file.name });

            const progress = file.status === 'success' ? '100%' :
                file.total > 0 ? `${Math.round((file.doneCount / file.total) * 100)}%` :
                file.status === 'error' ? localize('popup.publish-sog.failed') : '...';

            const statusText = file.status === 'error' ? (file.errorMessage || localize('popup.publish-sog.failed')) : progress;
            const statusLabel = new Label({ class: `file-status-${file.status}`, text: statusText });

            row.append(nameLabel);
            row.append(statusLabel);
            this._fileProgressContainer.append(row);
        }
    }
}

export { PublishSogDialog };
export type { PublishResult };
