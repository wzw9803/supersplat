import { Button, Container, Label, Progress, Spinner, TextAreaInput, TextInput } from '@playcanvas/pcui';
import { Events } from '../events';
import { localize } from './localization';
import { SogSettings } from '../splat-serialize';
import { uploadSogPackage, PublishProgress, PublishResult, UploadFileState } from '../sog-upload';
import { canSkipSerialize, buildFilesFromCache, isDataClean, areExportOptionsDefault, getSourceCache } from '../sog-source-cache';

type DialogPublishResult = {
    shareId: string;
    shareUrl: string;
    onlineShareUrl: string;
};

enum PublishPhase {
    INPUT = 'input',
    PREPARE = 'prepare',
    UPLOAD = 'upload',
    COMPLETE = 'complete',
    RESULT = 'result'
}

class PublishSogDialog extends Container {
    show: (sogSettings: SogSettings) => Promise<DialogPublishResult | null>;
    hide: () => void;
    destroy: () => void;

    // Input state
    private _contentInput: Container;
    private _nameInput: TextInput;
    private _ownerInput: TextInput;
    private _descInput: TextAreaInput;
    private _confirmButton: Button;
    private _cancelButton: Button;
    private _dirtyIndicator: Label;

    // Phase state
    private _contentPhases: Container;
    private _phase: PublishPhase = PublishPhase.INPUT;

    // Prepare phase
    private _prepareRow: Container;
    private _prepareIcon: Label;
    private _prepareLabel: Label;
    private _prepareProgress: Progress;
    private _prepareStatus: Label;

    // Upload phase
    private _uploadRow: Container;
    private _uploadIcon: Label;
    private _uploadLabel: Label;
    private _uploadProgress: Progress;
    private _uploadStatus: Label;
    private _toggleButton: Button;
    private _fileListContainer: Container;

    // Complete phase
    private _completeRow: Container;
    private _completeIcon: Label;
    private _completeLabel: Label;
    private _completeProgress: Progress;
    private _completeStatus: Label;

    // Result state (rendered inside _contentPhases below the checklist)
    private _resultInfo: Container;
    private _resultLabel: Label;
    private _linkInput: TextInput;
    private _linkInput2: TextInput;
    private _copyButton: Button;
    private _closeButton: Button;
    private _gotoButton: Button;
    private _gotoButton2: Button;

    // Reusable cancel button (changes behaviour per phase)
    private _phaseCancelButton: Button;

    // Per-show mutable state (handlers registered once in constructor, these are reassigned each show())
    private _resolve: ((value: DialogPublishResult | null) => void) | null = null;
    private _publishResult: DialogPublishResult | null = null;
    private _cancelSignal: { aborted: boolean } | undefined;
    private _retrySignal: { fileName: string | null } = { fileName: null };
    private _keydownHandler: ((e: KeyboardEvent) => void) | null = null;
    private _onConfirm: (() => void) | null = null;

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

        // ---- Header ----
        const header = new Container({ id: 'header' });
        const headerText = new Label({ id: 'text', text: localize('popup.publish-sog.header') });
        header.append(headerText);
        dialog.append(header);

        // ---- Input state content ----
        this._contentInput = new Container({ id: 'content-input' });

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

        const ownerRow = new Container({ class: 'row' });
        const ownerLabel = new Label({ class: 'label', text: localize('popup.publish-sog.owner') });
        this._ownerInput = new TextInput({ class: 'text-input' });
        ownerRow.append(ownerLabel);
        ownerRow.append(this._ownerInput);

        this._contentInput.append(nameRow);
        this._contentInput.append(ownerRow);
        this._contentInput.append(descRow);

        // Scene dirty status indicator (read-only, reflects fast-path eligibility)
        this._dirtyIndicator = new Label({ class: 'label', text: '' });
        this._contentInput.append(this._dirtyIndicator);

        dialog.append(this._contentInput);

        // ---- Phase content (checklist UI) ----
        this._contentPhases = new Container({ id: 'content', hidden: true });

        const phaseList = new Container({ class: 'phase-list' });

        // Prepare phase row
        this._prepareRow = new Container({ class: 'phase-row' });
        this._prepareIcon = new Label({ class: 'phase-icon', text: '○' }); // ○
        this._prepareLabel = new Label({ class: 'phase-label', text: localize('popup.publish-sog.phase-prepare') });
        this._prepareProgress = new Progress({ class: 'phase-progress', value: 0 });
        this._prepareStatus = new Label({ class: 'phase-status', text: localize('popup.publish-sog.status-waiting') });
        this._prepareRow.append(this._prepareIcon);
        this._prepareRow.append(this._prepareLabel);
        this._prepareRow.append(this._prepareProgress);
        this._prepareRow.append(this._prepareStatus);
        phaseList.append(this._prepareRow);

        // Upload phase row
        this._uploadRow = new Container({ class: 'phase-row' });
        this._uploadIcon = new Label({ class: 'phase-icon', text: '○' }); // ○
        this._uploadLabel = new Label({ class: 'phase-label', text: localize('popup.publish-sog.phase-upload') });
        this._uploadProgress = new Progress({ class: 'phase-progress', value: 0 });
        this._uploadStatus = new Label({ class: 'phase-status', text: localize('popup.publish-sog.status-waiting') });
        this._toggleButton = new Button({ class: 'toggle-button', text: '▶' }); // ▶
        this._uploadRow.append(this._uploadIcon);
        this._uploadRow.append(this._uploadLabel);
        this._uploadRow.append(this._uploadProgress);
        this._uploadRow.append(this._uploadStatus);
        this._uploadRow.append(this._toggleButton);
        phaseList.append(this._uploadRow);

        // File details container (collapsible)
        this._fileListContainer = new Container({ class: 'file-list', hidden: true });
        phaseList.append(this._fileListContainer);

        // Complete phase row
        this._completeRow = new Container({ class: 'phase-row' });
        this._completeIcon = new Label({ class: 'phase-icon', text: '○' }); // ○
        this._completeLabel = new Label({ class: 'phase-label', text: localize('popup.publish-sog.phase-complete') });
        this._completeProgress = new Progress({ class: 'phase-progress', value: 0 });
        this._completeStatus = new Label({ class: 'phase-status', text: localize('popup.publish-sog.status-waiting') });
        this._completeRow.append(this._completeIcon);
        this._completeRow.append(this._completeLabel);
        this._completeRow.append(this._completeProgress);
        this._completeRow.append(this._completeStatus);
        phaseList.append(this._completeRow);

        this._contentPhases.append(phaseList);

        // Result info — rendered below the phase checklist inside _contentPhases.
        this._resultInfo = new Container({ class: 'result-container' });
        this._resultLabel = new Label({ class: 'result-label', text: localize('popup.publish-sog.success') });
        const linkRow = new Container({ class: 'link-row' });
        const linkLabelTitle = new Label({ class: 'label', text: localize('popup.publish-sog.internal-link') });
        this._linkInput = new TextInput({ class: 'share-link-input' });
        linkRow.append(linkLabelTitle);
        linkRow.append(this._linkInput);
        const linkRow2 = new Container({ class: 'link-row' });
        const linkLabelTitle2 = new Label({ class: 'label', text: localize('popup.publish-sog.external-link') });
        this._linkInput2 = new TextInput({ class: 'share-link-input' });
        linkRow2.append(linkLabelTitle2);
        linkRow2.append(this._linkInput2);
        this._resultInfo.append(this._resultLabel);
        this._resultInfo.append(linkRow);
        this._resultInfo.append(linkRow2);
        this._contentPhases.append(this._resultInfo);
        dialog.append(this._contentPhases);

        // ---- Footer ----
        const footer = new Container({ id: 'footer' });

        // Buttons for INPUT state
        this._cancelButton = new Button({ class: 'button', text: localize('popup.cancel') });
        this._confirmButton = new Button({ class: 'button', text: localize('popup.publish-sog.confirm') });

        // Button for PREPARE/UPLOAD/COMPLETE phases
        this._phaseCancelButton = new Button({ class: 'button', text: localize('popup.cancel'), hidden: true });

        // Buttons for RESULT state
        this._closeButton = new Button({ class: 'button', text: localize('popup.publish-sog.close'), hidden: true });
        this._copyButton = new Button({ class: 'button', text: localize('popup.publish-sog.copy-link'), hidden: true });
        this._gotoButton = new Button({ class: 'button', text: localize('popup.publish-sog.goto'), hidden: true });
        this._gotoButton2 = new Button({ class: 'button', text: localize('popup.publish-sog.goto-external'), hidden: true });

        footer.append(this._cancelButton);
        footer.append(this._confirmButton);
        footer.append(this._phaseCancelButton);
        footer.append(this._closeButton);
        footer.append(this._copyButton);
        footer.append(this._gotoButton);
        footer.append(this._gotoButton2);

        dialog.append(footer);
        this.append(dialog);

        // ---- State management ----
        const setPhaseState = (phase: PublishPhase) => {
            this._phase = phase;

            const isInput = phase === PublishPhase.INPUT;
            const isResult = phase === PublishPhase.RESULT;
            // _contentPhases is visible during PREPARE/UPLOAD/COMPLETE *and* RESULT
            const isPhases = !isInput;

            this._contentInput.hidden = !isInput;
            this._contentPhases.hidden = !isPhases;
            this._resultInfo.hidden = !isResult;

            // Footer buttons
            this._cancelButton.hidden = !isInput;
            this._confirmButton.hidden = !isInput;
            this._phaseCancelButton.hidden = isInput || isResult;
            this._closeButton.hidden = !isResult;
            this._copyButton.hidden = !isResult;
            this._gotoButton.hidden = !isResult;
            this._gotoButton2.hidden = !isResult;

            // Cancel button enabled only in PREPARE phase
            this._phaseCancelButton.enabled = phase === PublishPhase.PREPARE;
        };

        // ---- Update icon helpers ----
        const setPhaseIcon = (icon: Label, phaseState: 'waiting' | 'active' | 'done' | 'error') => {
            icon.class.remove('phase-icon-done', 'phase-icon-error', 'phase-icon-active');
            switch (phaseState) {
                case 'done':
                    icon.text = '✓'; // ✓
                    icon.class.add('phase-icon-done');
                    break;
                case 'active':
                    icon.text = ''; // Spinner will be used instead
                    icon.class.add('phase-icon-active');
                    break;
                case 'error':
                    icon.text = '✗'; // ✗
                    icon.class.add('phase-icon-error');
                    break;
                default:
                    icon.text = '○'; // ○
                    break;
            }
        };

        // ---- Toggle file list ----
        let fileListExpanded = false;
        this._toggleButton.on('click', () => {
            fileListExpanded = !fileListExpanded;
            this._fileListContainer.hidden = !fileListExpanded;
            this._toggleButton.text = fileListExpanded ? '▼' : '▶'; // ▼ : ▶
        });

        // ---- Copy button ----
        this._copyButton.on('click', () => {
            const internalUrl = this._linkInput.value;
            const externalUrl = this._linkInput2.value;
            if (!internalUrl && !externalUrl) return;
            const noLink = localize('popup.publish-sog.no-external-link');
            const text = `内网链接：${internalUrl || noLink}\n外网链接：${externalUrl || noLink}`;
            navigator.clipboard.writeText(text).then(() => {
                const orig = this._copyButton.text;
                this._copyButton.text = localize('popup.publish-sog.copy-success');
                setTimeout(() => {
                    this._copyButton.text = orig;
                }, 2000);
            }).catch(() => {
                // ignore clipboard errors
            });
        });

        // ---- Goto buttons ----
        this._gotoButton.on('click', () => {
            const url = this._linkInput.value;
            if (url) window.open(url, '_blank');
        });

        this._gotoButton2.on('click', () => {
            const url = this._linkInput2.value;
            if (url) window.open(url, '_blank');
        });

        // ---- Form validation (name + owner required) ----
        const validateForm = () => {
            this._confirmButton.disabled = !this._nameInput.value.trim() || !this._ownerInput.value.trim();
        };
        this._nameInput.on('change', validateForm);
        this._ownerInput.on('change', validateForm);

        // ---- Button handlers (registered once) ----
        // Each handler reads this._resolve / this._publishResult which are
        // reassigned per show() call — avoids listener leak on repeated show().

        this._cancelButton.on('click', () => {
            if (this._phase === PublishPhase.INPUT) {
                this._resolve?.(null);
            } else if (this._phase === PublishPhase.PREPARE) {
                if (this._cancelSignal) this._cancelSignal.aborted = true;
                this._resolve?.(null);
            }
        });

        this._phaseCancelButton.on('click', () => {
            if (this._phase === PublishPhase.PREPARE) {
                if (this._cancelSignal) this._cancelSignal.aborted = true;
                this._resolve?.(null);
            } else {
                // Non-PREPARE: button acts as "Close" (e.g. in error state)
                this._resolve?.(null);
            }
        });

        this._closeButton.on('click', () => {
            if (this._phase === PublishPhase.RESULT && this._publishResult) {
                this._resolve?.(this._publishResult);
            } else {
                this._resolve?.(null);
            }
        });

        this._confirmButton.on('click', () => {
            // Per-show onConfirm is assigned to _onConfirm in show()
            if (this._onConfirm) this._onConfirm();
        });

        // ---- show() method ----
        this.show = (sogSettings: SogSettings) => {
            // Reset UI
            this._nameInput.value = '';
            this._ownerInput.value = '';
            this._descInput.value = '';
            this._confirmButton.disabled = true;
            this._linkInput.value = '';
            this._linkInput2.value = '';
            this._prepareProgress.value = 0;
            this._uploadProgress.value = 0;
            this._completeProgress.value = 0;
            setPhaseIcon(this._prepareIcon, 'waiting');
            setPhaseIcon(this._uploadIcon, 'waiting');
            setPhaseIcon(this._completeIcon, 'waiting');
            this._prepareStatus.text = localize('popup.publish-sog.status-waiting');
            this._uploadStatus.text = localize('popup.publish-sog.status-waiting');
            this._completeStatus.text = localize('popup.publish-sog.status-waiting');
            this._fileListContainer.clear();
            this._fileListContainer.hidden = true;
            this._resultInfo.hidden = true;
            fileListExpanded = false;
            this._toggleButton.text = '▶';

            setPhaseState(PublishPhase.INPUT);
            this.hidden = false;
            this.dom.focus();

            // Update fast path eligibility indicator
            const splats = events.invoke('scene.splats');
            const canFastPath = splats && splats.length === 1 && canSkipSerialize(splats, sogSettings, sogSettings.iterations);
            if (canFastPath) {
                this._dirtyIndicator.text = '⚡ 数据未修改 · 将使用快速通道（跳过序列化）';
            } else if (splats && splats.length === 1 && !getSourceCache(splats[0])) {
                this._dirtyIndicator.text = '📦 无 SOG 缓存 · 需要重新序列化';
            } else if (splats && splats.length === 1 && !isDataClean(splats[0])) {
                this._dirtyIndicator.text = '🔧 高斯数据已修改 · 需要重新序列化';
            } else if (splats && splats.length === 1 && !areExportOptionsDefault(sogSettings, sogSettings.iterations)) {
                this._dirtyIndicator.text = '⚙️ 导出选项非默认值 · 需要重新序列化';
            } else {
                this._dirtyIndicator.text = '🔄 需要重新序列化';
            }

            // Reset per-show mutable state
            this._publishResult = null;
            this._cancelSignal = undefined;
            this._retrySignal = { fileName: null };
            // Reset phase-cancel button to default text/enabled (error handler may have changed it)
            this._phaseCancelButton.text = localize('popup.cancel');
            this._phaseCancelButton.enabled = true;

            return new Promise<DialogPublishResult | null>((resolve) => {
                this._resolve = resolve;

                // Keyboard handler (reassigned each show())
                this._keydownHandler = (e: KeyboardEvent) => {
                    switch (e.key) {
                        case 'Escape':
                            if (this._phase === PublishPhase.INPUT || this._phase === PublishPhase.PREPARE) {
                                if (this._phase === PublishPhase.PREPARE && this._cancelSignal) {
                                    this._cancelSignal.aborted = true;
                                }
                                resolve(null);
                            }
                            break;
                        case 'Enter':
                            if (!e.shiftKey && this._phase === PublishPhase.INPUT && !this._confirmButton.disabled) {
                                this._onConfirm?.();
                            }
                            break;
                        default:
                            e.stopPropagation();
                            break;
                    }
                };
                this.dom.addEventListener('keydown', this._keydownHandler);

                // ---- Confirm publish handler (reassigned each show()) ----
                this._onConfirm = async () => {
                    const projectName = this._nameInput.value.trim();
                    const owner = this._ownerInput.value.trim();
                    if (!projectName || !owner) {
                        this._confirmButton.disabled = true;
                        return;
                    }

                    const splats = events.invoke('scene.splats');
                    if (!splats || splats.length === 0) return;

                    // Switch to PREPARE phase — yield to browser for paint before heavy work
                    setPhaseState(PublishPhase.PREPARE);
                    setPhaseIcon(this._prepareIcon, 'active');
                    this._prepareStatus.text = localize('popup.publish-sog.status-waiting');

                    this._cancelSignal = { aborted: false };
                    this._retrySignal = { fileName: null };

                    // Fast path: skip extractDataTable + writeSogInternal if data is
                    // unchanged and export options are at their defaults.
                    const targetFormat = (sogSettings as any).sogFormat || 'unbundled';
                    let prebuiltFiles: Array<{ name: string; data: Uint8Array }> | undefined;

                    if (canSkipSerialize(splats, sogSettings, sogSettings.iterations)) {
                        try {
                            prebuiltFiles = await buildFilesFromCache(
                                splats,
                                sogSettings.sceneConfig,
                                targetFormat
                            );
                        } catch (err) {
                            console.warn('[publish] Cache build failed, fallback to serialization:', err);
                            prebuiltFiles = undefined;
                        }
                    }

                    // Yield to the browser so the PREPARE UI renders before
                    // serializeSogToFiles blocks the main thread
                    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

                    const onProgress = (progress: PublishProgress) => {
                        if (this._cancelSignal?.aborted) return;

                        switch (progress.phase) {
                            case 'prepare':
                                if (typeof progress.prepareProgress === 'number') {
                                    this._prepareProgress.value = progress.prepareProgress;
                                    if (progress.prepareProgress > 0) {
                                        this._prepareStatus.text = `${progress.prepareProgress}%`;
                                    }
                                }
                                break;

                            case 'upload':
                                if (this._phase !== PublishPhase.UPLOAD) {
                                    setPhaseState(PublishPhase.UPLOAD);
                                    setPhaseIcon(this._prepareIcon, 'done');
                                    this._prepareStatus.text = localize('popup.publish-sog.status-done');
                                    this._prepareProgress.value = 100;
                                    setPhaseIcon(this._uploadIcon, 'active');
                                }

                                if (typeof progress.uploadProgress === 'number') {
                                    this._uploadProgress.value = progress.uploadProgress;
                                    this._uploadStatus.text = `${progress.uploadProgress}%`;
                                }
                                if (progress.files) {
                                    this._renderFileList(progress.files, this._retrySignal);
                                }
                                break;

                            case 'complete':
                                setPhaseIcon(this._uploadIcon, 'done');
                                this._uploadStatus.text = localize('popup.publish-sog.status-done');
                                this._uploadProgress.value = 100;
                                setPhaseState(PublishPhase.COMPLETE);
                                setPhaseIcon(this._completeIcon, 'active');
                                this._completeProgress.value = 50;
                                this._completeStatus.text = localize('popup.publish-sog.status-completing');
                                break;
                        }
                    };

                    try {
                        const result = await uploadSogPackage(
                            splats,
                            sogSettings,
                            projectName,
                            this._descInput.value.trim(),
                            owner,
                            onProgress,
                            this._cancelSignal,
                            this._retrySignal,
                            prebuiltFiles
                        );

                        this._cancelSignal = undefined;

                        setPhaseIcon(this._completeIcon, 'done');
                        this._completeStatus.text = localize('popup.publish-sog.status-done');
                        this._completeProgress.value = 100;

                        this._publishResult = { shareId: result.shareId, shareUrl: result.shareUrl, onlineShareUrl: result.onlineShareUrl };
                        this._linkInput.value = result.shareUrl || localize('popup.publish-sog.no-external-link');
                        this._linkInput2.value = result.onlineShareUrl || localize('popup.publish-sog.no-external-link');
                        this._gotoButton2.enabled = !!result.onlineShareUrl;
                        setPhaseState(PublishPhase.RESULT);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);

                        if (msg === 'Cancelled' || msg === 'Upload cancelled by user') {
                            resolve(null);
                            return;
                        }

                        if (this._phase === PublishPhase.PREPARE) {
                            setPhaseIcon(this._prepareIcon, 'error');
                            this._prepareStatus.text = msg;
                        } else if (this._phase === PublishPhase.UPLOAD) {
                            setPhaseIcon(this._uploadIcon, 'error');
                            this._uploadStatus.text = msg;
                        } else if (this._phase === PublishPhase.COMPLETE) {
                            setPhaseIcon(this._completeIcon, 'error');
                            this._completeStatus.text = msg;
                        }

                        // Keep dialog open for error inspection; turn cancel button into close
                        this._phaseCancelButton.enabled = true;
                        this._phaseCancelButton.text = localize('popup.publish-sog.close');
                    }
                };
            }).finally(() => {
                if (this._keydownHandler) {
                    this.dom.removeEventListener('keydown', this._keydownHandler);
                    this._keydownHandler = null;
                }
                this._resolve = null;
                this._onConfirm = null;
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

    /**
     * Render the file list inside the collapsible container.
     * Each file gets a row showing name, status, and (when failed) a retry button.
     */
    private _renderFileList(files: UploadFileState[], retrySignal: { fileName: string | null }) {
        this._fileListContainer.clear();

        for (const file of files) {
            const row = new Container({ class: 'file-row' });

            const nameLabel = new Label({ class: 'file-name', text: file.name });

            let statusText: string;
            let statusClass: string;
            if (file.status === 'success') {
                statusText = '100%';
                statusClass = 'file-status-success';
            } else if (file.status === 'error') {
                statusText = file.errorMessage || localize('popup.publish-sog.failed');
                statusClass = 'file-status-error';
            } else if (file.status === 'paused') {
                statusText = localize('popup.publish-sog.status-waiting');
                statusClass = 'file-status-paused';
            } else if (file.total > 0) {
                const pct = Math.round((file.doneCount / file.total) * 100);
                statusText = `${pct}%`;
                statusClass = 'file-status-uploading';
            } else {
                statusText = '...';
                statusClass = 'file-status-pending';
            }

            const statusLabel = new Label({ class: statusClass, text: statusText });

            row.append(nameLabel);
            row.append(statusLabel);

            // Retry button for failed files
            if (file.status === 'error') {
                const retryBtn = new Button({ class: 'retry-button', text: localize('popup.publish-sog.retry') });
                retryBtn.on('click', () => {
                    retrySignal.fileName = file.name;
                    statusLabel.text = localize('popup.publish-sog.status-uploading');
                    statusLabel.class.remove('file-status-error');
                    statusLabel.class.add('file-status-uploading');
                    retryBtn.enabled = false;
                    // The upload callback will update this row on the next progress tick
                });
                row.append(retryBtn);
            }

            this._fileListContainer.append(row);
        }
    }
}

export { PublishSogDialog };
export type { DialogPublishResult };
