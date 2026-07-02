import { BooleanInput, Button, ColorPicker, Container, Element, Label, SelectInput, SliderInput, TextInput } from '@playcanvas/pcui';

import { Pose } from '../camera-poses';
import { localize } from './localization';
import { Events } from '../events';
import { ExportType, SceneExportOptions } from '../file-handler';
import { AnimTrack, ExperienceSettings, defaultPostEffectSettings } from '../splat-serialize';
import sceneExport from './svg/export.svg';
import { getSourceCache } from '../sog-source-cache';

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

const removeKnownExtension = (filename: string) => {
    // remove known extensions (ordered from longest to shortest for compound extensions)
    const knownExtensions = [
        '.compressed.ply',
        '.ksplat',
        '.splat',
        '.html',
        '.ply',
        '.sog',
        '.spz',
        '.lcc',
        '.zip'
    ];

    for (let i = 0; i < knownExtensions.length; ++i) {
        const ext = knownExtensions[i];
        if (filename.endsWith(ext)) {
            return filename.slice(0, -ext.length);
        }
    }

    return filename;
};

class ExportPopup extends Container {
    show: (exportType: ExportType, splatNames: string[], showFilenameEdit: boolean) => Promise<null | SceneExportOptions>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            id: 'export-popup',
            hidden: true,
            tabIndex: -1,
            ...args
        };

        super(args);

        // UI

        const dialog = new Container({
            id: 'dialog'
        });

        // header

        const header = new Container({
            id: 'header'
        });

        const headerText = new Label({
            id: 'header',
            text: localize('popup.export.header')
        });

        header.append(createSvg(sceneExport, {
            id: 'icon'
        }));

        header.append(headerText);

        // content

        const content = new Container({ id: 'content' });

        // type

        const viewerTypeRow = new Container({
            class: 'row'
        });

        const viewerTypeLabel = new Label({
            class: 'label',
            text: localize('popup.export.type')
        });

        const viewerTypeSelect = new SelectInput({
            class: 'select',
            defaultValue: 'html',
            options: [
                { v: 'html', t: localize('popup.export.html') },
                { v: 'zip', t: localize('popup.export.package') }
            ]
        });

        viewerTypeRow.append(viewerTypeLabel);
        viewerTypeRow.append(viewerTypeSelect);

        // viewer: animation

        const animationLabel = new Label({ class: 'label', text: localize('popup.export.animation') });
        const animationToggle = new BooleanInput({ class: 'boolean', type: 'toggle', value: false });
        const animationRow = new Container({ class: 'row' });
        animationRow.append(animationLabel);
        animationRow.append(animationToggle);

        // viewer: loop mode

        const loopLabel = new Label({ class: 'label', text: localize('popup.export.loop-mode') });
        const loopSelect = new SelectInput({
            class: 'select',
            defaultValue: 'repeat',
            options: [
                { v: 'none', t: localize('popup.export.loop-mode.none') },
                { v: 'repeat', t: localize('popup.export.loop-mode.repeat') },
                { v: 'pingpong', t: localize('popup.export.loop-mode.pingpong') }
            ]
        });
        const loopRow = new Container({ class: 'row' });
        loopRow.append(loopLabel);
        loopRow.append(loopSelect);

        // viewer: clear color

        const colorRow = new Container({
            class: 'row'
        });

        const colorLabel = new Label({
            class: 'label',
            text: localize('popup.export.background-color')
        });

        const colorPicker = new ColorPicker({
            class: 'color-picker',
            value: [1, 1, 1, 1]
        });

        colorRow.append(colorLabel);
        colorRow.append(colorPicker);

        // viewer: fov

        const fovRow = new Container({
            class: 'row'
        });

        const fovLabel = new Label({
            class: 'label',
            text: localize('popup.export.fov')
        });

        const fovSlider = new SliderInput({
            class: 'slider',
            min: 10,
            max: 120,
            precision: 0,
            value: 60
        });

        fovRow.append(fovLabel);
        fovRow.append(fovSlider);

        // viewer: tonemapping

        const tonemappingRow = new Container({
            class: 'row'
        });

        const tonemappingLabel = new Label({
            class: 'label',
            text: localize('panel.view-options.tonemapping')
        });

        const tonemappingSelect = new SelectInput({
            class: 'select',
            defaultValue: 'none',
            options: [
                { v: 'none', t: localize('panel.view-options.tonemapping.none') },
                { v: 'linear', t: localize('panel.view-options.tonemapping.linear') },
                { v: 'neutral', t: localize('panel.view-options.tonemapping.neutral') },
                { v: 'aces', t: localize('panel.view-options.tonemapping.aces') },
                { v: 'aces2', t: localize('panel.view-options.tonemapping.aces2') },
                { v: 'filmic', t: localize('panel.view-options.tonemapping.filmic') },
                { v: 'hejl', t: localize('panel.view-options.tonemapping.hejl') }
            ]
        });

        tonemappingRow.append(tonemappingLabel);
        tonemappingRow.append(tonemappingSelect);

        // compress

        const compressRow = new Container({
            class: 'row'
        });

        const compressLabel = new Label({
            class: 'label',
            text: localize('popup.export.compress-ply')
        });

        const compressBoolean = new BooleanInput({
            class: 'boolean',
            type: 'toggle'
        });

        compressRow.append(compressLabel);
        compressRow.append(compressBoolean);

        // spherical harmonic bands

        const bandsRow = new Container({
            class: 'row'
        });

        const bandsLabel = new Label({
            class: 'label',
            text: localize('popup.export.sh-bands')
        });

        const bandsSlider = new SliderInput({
            class: 'slider',
            min: 0,
            max: 3,
            precision: 0,
            value: 3
        });

        bandsRow.append(bandsLabel);
        bandsRow.append(bandsSlider);

        // sog iterations

        const iterationsRow = new Container({
            class: 'row'
        });

        const iterationsLabel = new Label({
            class: 'label',
            text: localize('popup.export.iterations')
        });

        const iterationsSlider = new SliderInput({
            class: 'slider',
            min: 1,
            max: 20,
            precision: 0,
            value: 10
        });

        iterationsRow.append(iterationsLabel);
        iterationsRow.append(iterationsSlider);

        // min opacity

        const minOpacityRow = new Container({
            class: 'row'
        });

        const minOpacityLabel = new Label({
            class: 'label',
            text: localize('popup.export.min-opacity')
        });

        const minOpacitySlider = new SliderInput({
            class: 'slider',
            min: 0,
            max: 1,
            precision: 3,
            value: 1 / 255
        });

        minOpacityRow.append(minOpacityLabel);
        minOpacityRow.append(minOpacitySlider);

        // remove invalid

        const removeInvalidRow = new Container({
            class: 'row'
        });

        const removeInvalidLabel = new Label({
            class: 'label',
            text: localize('popup.export.remove-invalid')
        });

        const removeInvalidToggle = new BooleanInput({
            class: 'boolean',
            type: 'toggle',
            value: true
        });

        removeInvalidRow.append(removeInvalidLabel);
        removeInvalidRow.append(removeInvalidToggle);

        // sog format (bundled / unbundled)

        const sogFormatRow = new Container({
            class: 'row'
        });

        const sogFormatLabel = new Label({
            class: 'label',
            text: localize('popup.export.sog-format')
        });

        const sogFormatSelect = new SelectInput({
            class: 'select',
            defaultValue: 'unbundled',
            options: [
                { v: 'bundled', t: localize('popup.export.sog-format.bundled') },
                { v: 'unbundled', t: localize('popup.export.sog-format.unbundled') }
            ]
        });

        sogFormatRow.append(sogFormatLabel);
        sogFormatRow.append(sogFormatSelect);

        // include settings

        const includeSettingsRow = new Container({
            class: 'row'
        });

        const includeSettingsLabel = new Label({
            class: 'label',
            text: localize('popup.export.include-settings')
        });

        const includeSettingsToggle = new BooleanInput({
            class: 'boolean',
            type: 'toggle',
            value: true
        });

        includeSettingsRow.append(includeSettingsLabel);
        includeSettingsRow.append(includeSettingsToggle);

        // filename

        const filenameRow = new Container({
            class: 'row'
        });

        const filenameLabel = new Label({
            class: 'label',
            text: localize('popup.export.filename')
        });

        const filenameEntry = new TextInput({
            class: 'text-input'
        });

        filenameRow.append(filenameLabel);
        filenameRow.append(filenameEntry);

        // content

        content.append(viewerTypeRow);
        content.append(animationRow);
        content.append(loopRow);
        content.append(colorRow);
        content.append(fovRow);
        content.append(tonemappingRow);
        content.append(compressRow);
        content.append(bandsRow);
        content.append(iterationsRow);
        content.append(minOpacityRow);
        content.append(removeInvalidRow);
        content.append(sogFormatRow);
        content.append(includeSettingsRow);
        content.append(filenameRow);

        // footer

        const footer = new Container({ id: 'footer' });

        const cancelButton = new Button({
            class: 'button',
            text: localize('popup.cancel')
        });

        const exportButton = new Button({
            class: 'button',
            text: localize('popup.export')
        });

        const publishButton = new Button({
            class: 'button',
            text: localize('popup.export.publish'),
            hidden: true
        });

        footer.append(cancelButton);
        footer.append(exportButton);
        footer.append(publishButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        // handlers

        let onCancel: () => void;
        let onExport: () => void;
        let onPublish: () => void;

        cancelButton.on('click', () => onCancel());
        exportButton.on('click', () => onExport());
        publishButton.on('click', () => onPublish());

        const keydown = (e: KeyboardEvent) => {
            switch (e.key) {
                case 'Escape':
                    onCancel();
                    break;
                case 'Enter':
                    if (!e.shiftKey) onExport();
                    break;
                default:
                    e.stopPropagation();
                    break;
            }
        };

        const updateExtension = (ext: string) => {
            filenameEntry.value = removeKnownExtension(filenameEntry.value) + ext;
        };

        compressBoolean.on('change', () => {
            updateExtension(compressBoolean.value ? '.compressed.ply' : '.ply');
        });

        viewerTypeSelect.on('change', () => {
            updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
        });

        animationToggle.on('change', (value: boolean) => {
            loopSelect.enabled = value;
        });

        includeSettingsToggle.on('change', (value: boolean) => {
            colorRow.hidden = !value;
            fovRow.hidden = !value;
            tonemappingRow.hidden = !value;
            animationRow.hidden = !value;
            loopRow.hidden = !value || !animationToggle.value;
            loopSelect.enabled = value && animationToggle.value;
        });

        const reset = (exportType: ExportType, splatNames: string[], hasPoses: boolean) => {
            const allRows = [
                viewerTypeRow, animationRow, loopRow, colorRow, fovRow, tonemappingRow, compressRow, bandsRow, iterationsRow, minOpacityRow, removeInvalidRow, sogFormatRow, includeSettingsRow, filenameRow
            ];

            const activeRows = {
                ply: [compressRow, bandsRow, filenameRow],
                splat: [filenameRow],
                sog: [bandsRow, iterationsRow, filenameRow],
                'sog-package': [bandsRow, iterationsRow, minOpacityRow, removeInvalidRow, sogFormatRow, includeSettingsRow, colorRow, fovRow, tonemappingRow, animationRow, loopRow, filenameRow],
                viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, tonemappingRow, bandsRow, filenameRow]
            }[exportType];

            allRows.forEach((r) => {
                r.hidden = activeRows.indexOf(r) === -1;
            });

            bandsSlider.value = events.invoke('view.bands');

            // tonemapping
            tonemappingSelect.value = events.invoke('camera.tonemapping') || 'none';

            // ply
            compressBoolean.value = false;

            // sog
            iterationsSlider.value = 10;

            // sog-package
            minOpacitySlider.value = 1 / 255;
            removeInvalidToggle.value = true;
            // Auto-detect sogFormat from cached source files (fast publish optimization)
            {
                const splats = events.invoke('scene.splats');
                if (splats && splats.length === 1) {
                    const sourceCache = getSourceCache(splats[0]);
                    sogFormatSelect.value = sourceCache ? sourceCache.format : 'unbundled';
                } else {
                    sogFormatSelect.value = 'unbundled';
                }
            }
            includeSettingsToggle.value = true;

            // filename
            filenameEntry.value = splatNames[0];
            switch (exportType) {
                case 'ply':
                    updateExtension('.ply');
                    break;
                case 'splat':
                    updateExtension('.splat');
                    break;
                case 'sog':
                    updateExtension('.sog');
                    break;
                case 'sog-package':
                    updateExtension('.zip');
                    break;
                case 'viewer':
                    updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
                    break;
            }

            // sog-package: settings rows visibility (default visible)
            colorRow.hidden = false;
            fovRow.hidden = false;
            tonemappingRow.hidden = false;
            animationRow.hidden = false;
            loopRow.hidden = false;
            loopSelect.enabled = animationToggle.value;

            // viewer
            const bgClr = events.invoke('bgClr');

            animationToggle.value = hasPoses;
            animationToggle.enabled = hasPoses;
            loopSelect.value = 'repeat';
            loopSelect.enabled = hasPoses;

            colorPicker.value = [bgClr.r, bgClr.g, bgClr.b];

            fovSlider.value = events.invoke('camera.fov');
        };

        this.show = (exportType: ExportType, splatNames: string[], showFilenameEdit: boolean) => {
            const frames = events.invoke('timeline.frames');
            const frameRate = events.invoke('timeline.frameRate');
            const smoothness = events.invoke('timeline.smoothness');
            const orderedPoses = (events.invoke('camera.poses') as Pose[])
            .slice()
            .filter(p => p.frame >= 0 && p.frame < frames)
            .sort((a, b) => a.frame - b.frame);

            reset(exportType, splatNames, orderedPoses.length > 0);

            // publish button only shown for sog-package export
            publishButton.hidden = exportType !== 'sog-package';

            // filename is only shown in safari where file picker is not supported
            filenameRow.hidden = !showFilenameEdit;

            this.hidden = false;
            this.dom.addEventListener('keydown', keydown);
            this.dom.focus();

            const assemblePlyOptions = () : SceneExportOptions => {
                return {
                    filename: filenameEntry.value,
                    splatIdx: 'all',
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    compressedPly: compressBoolean.value
                };
            };

            const assembleSplatOptions = () : SceneExportOptions => {
                return {
                    filename: filenameEntry.value,
                    splatIdx: 'all',
                    serializeSettings: { }
                };
            };

            const assembleSogOptions = () : SceneExportOptions => {
                return {
                    filename: filenameEntry.value,
                    splatIdx: 'all',
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    sogIterations: iterationsSlider.value
                };
            };

            // Shared helper to build ExperienceSettings for viewer and sog-package exports
            const assembleExperienceSettings = (includeAnimation: boolean): ExperienceSettings => {
                const fov = fovSlider.value;

                // use current viewport as start pose
                const pose = events.invoke('camera.getPose');
                const p = pose?.position;
                const t = pose?.target;
                const cameras = (p && t) ? [{
                    initial: {
                        position: [p.x, p.y, p.z] as [number, number, number],
                        target: [t.x, t.y, t.z] as [number, number, number],
                        fov
                    }
                }] : [];

                const animTracks: AnimTrack[] = [];

                if (includeAnimation && orderedPoses.length > 0) {
                    const times: number[] = [];
                    const position: number[] = [];
                    const target: number[] = [];
                    const fovKeys: number[] = [];
                    for (let i = 0; i < orderedPoses.length; ++i) {
                        const op = orderedPoses[i];
                        times.push(op.frame);
                        position.push(op.position.x, op.position.y, op.position.z);
                        target.push(op.target.x, op.target.y, op.target.z);
                        fovKeys.push(op.fov ?? fov);
                    }

                    animTracks.push({
                        name: 'cameraAnim',
                        duration: frames / frameRate,
                        frameRate,
                        loopMode: loopSelect.value as 'none' | 'repeat' | 'pingpong',
                        interpolation: 'spline',
                        smoothness,
                        keyframes: {
                            times,
                            values: { position, target, fov: fovKeys }
                        }
                    });
                }

                const bgColor = colorPicker.value.slice(0, 3) as [number, number, number];

                return {
                    version: 2,
                    tonemapping: tonemappingSelect.value as ExperienceSettings['tonemapping'],
                    highPrecisionRendering: false,
                    background: { color: bgColor },
                    postEffectSettings: defaultPostEffectSettings,
                    animTracks,
                    cameras,
                    annotations: [],
                    startMode: includeAnimation ? 'animTrack' : 'default'
                };
            };

            const assembleViewerOptions = () : SceneExportOptions => {
                return {
                    filename: filenameEntry.value,
                    splatIdx: 'all',
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    viewerExportSettings: {
                        type: viewerTypeSelect.value,
                        experienceSettings: assembleExperienceSettings(animationToggle.value)
                    }
                };
            };

            const assembleSogPackageOptions = () : SceneExportOptions => {
                const includeSettings = includeSettingsToggle.value;
                const sogFormat = sogFormatSelect.value as 'bundled' | 'unbundled';

                const result: SceneExportOptions = {
                    filename: filenameEntry.value,
                    splatIdx: 'all',
                    serializeSettings: {
                        maxSHBands: bandsSlider.value,
                        minOpacity: minOpacitySlider.value,
                        removeInvalid: removeInvalidToggle.value
                    },
                    sogExportSettings: {
                        iterations: iterationsSlider.value,
                        sogFormat,
                        includeSettings
                    }
                };

                if (includeSettings) {
                    const fov = fovSlider.value;
                    const pose = events.invoke('camera.getPose');
                    const name = removeKnownExtension(splatNames[0]);

                    const cameraPosition: [number, number, number] = pose?.position ?
                        [pose.position.x, pose.position.y, pose.position.z] :
                        [0, 0, 0];
                    const cameraTarget: [number, number, number] = pose?.target ?
                        [pose.target.x, pose.target.y, pose.target.z] :
                        [0, 0, 0];

                    console.log('🔵 [supersplat] 导出 sceneConfig 相机数据:');
                    console.log('  position:', cameraPosition);
                    console.log('  target:', cameraTarget);
                    console.log('  fov:', fov);
                    console.log('  rotation(场景节点):', [0, 0, 180]);
                    console.log('  position(场景节点):', [0, 0, 0]);

                    result.sogExportSettings!.sceneConfig = {
                        name,
                        type: 'scene',
                        url: sogFormat === 'bundled' ? 'output.sog' : 'meta.json',
                        position: [0, 0, 0],
                        rotation: [0, 0, 180],
                        scale: [1, 1, 1],
                        config: {
                            camera: {
                                fov,
                                eyeHeight: 1.35,
                                position: [cameraPosition[0], 1.35, cameraPosition[2]],
                                target: [cameraTarget[0], 1.35, cameraTarget[2]]
                            },
                            toneMapping: tonemappingSelect.value,
                            animation: '',
                            sceneType: 'indoor'
                        }
                    };
                }

                return result;
            };

            return new Promise<null | SceneExportOptions>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onExport = () => {
                    switch (exportType) {
                        case 'ply':
                            resolve(assemblePlyOptions());
                            break;
                        case 'splat':
                            resolve(assembleSplatOptions());
                            break;
                        case 'sog':
                            resolve(assembleSogOptions());
                            break;
                        case 'sog-package':
                            resolve(assembleSogPackageOptions());
                            break;
                        case 'viewer':
                            resolve(assembleViewerOptions());
                            break;
                    }
                };

                onPublish = () => {
                    // Show publish dialog on top of ExportPopup (modal-on-modal).
                    // Do NOT resolve the main promise — ExportPopup stays visible.
                    const sogOptions = assembleSogPackageOptions();
                    if (sogOptions.sogExportSettings) {
                        // Combine serializeSettings + sogExportSettings into SogSettings
                        const sogSettings = {
                            ...sogOptions.serializeSettings,
                            ...sogOptions.sogExportSettings,
                            events
                        };
                        events.fire('publish.sog.show', sogSettings);
                    }
                };
            }).finally(() => {
                this.dom.removeEventListener('keydown', keydown);
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
}

export { ExportPopup };
