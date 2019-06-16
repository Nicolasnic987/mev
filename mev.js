// ES6
import { VrmModel, VrmRenderer } from './vrm.js';
import { setupStartDialog } from './components/start-dialog.js';
import { } from './components/menu-section-emotion.js';
import { } from './components/menu-section-image.js';
import { flatten, objectToTreeDebug, blendshapeToEmotionId } from './mev-util.js';

const EMOTION_PRESET_GROUPING = [
    ["neutral"],
    ["a", "i", "u", "e", "o"],
    ["joy", "angry", "sorrow", "fun"],
    ["blink", "blink_l", "blink_r"],
    ["lookleft", "lookright", "lookup", "lookdown"],
    // All unknown will go into the last group.
];

const EMOTION_PRESET_NAME_TO_LABEL = {
    "neutral": "標準",
    "a": "あ",
    "i": "い",
    "u": "う",
    "e": "え",
    "o": "お",
    "joy": "喜",
    "angry": "怒",
    "sorrow": "哀",
    "fun": "楽",
    "blink": "瞬目",
    "blink_l": "瞬目:左",
    "blink_r": "瞬目:右",
    // TODO: isn't this left-right etc. technical limitation of Unity? (i.e. not being able to set negative weight)?
    // Better to automate by detecting symmetry.
    "lookleft": "目←",
    "lookright": "目→",
    "lookup": "目↑",
    "lookdown": "目↓",
};

/**
 * Load FBX and try to convert to proper VRM (ideally, same as loadVrm but currently conversion is very broken)
 * @param {ArrayBuffer} fileContent 
 * @return {Promise<THREE.Object3D>} vrmRoot
 */
function importFbxAsVrm(fileContent) {
    return new Promise((resolve, reject) => {
        const fbxLoader = new THREE.FBXLoader();
        fbxLoader.load(
            fileContent,
            fbx => {
                console.log("FBX loaded", fbx);
                const bb_size = new THREE.Box3().setFromObject(fbx).getSize();
                const max_len = Math.max(bb_size.x, bb_size.y, bb_size.z);
                // heuristics: Try to fit in 0.1m~9.9m. (=log10(max_len * K) should be 0.XXX)
                // const scale_factor = Math.pow(10, -Math.floor(Math.log10(max_len)));
                //console.log("FBX:size_estimator: max_len=", max_len, "scale_factor=", scale_factor);
                const scale_factor = 0.01;
                fbx.scale.set(scale_factor, scale_factor, scale_factor);
                fbx.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), Math.PI);

                // Fix-up materials
                fbx.traverse(obj => {
                    if (obj.type === 'SkinnedMesh' || obj.type === 'Mesh') {
                        console.log("FBX-Fix-Material", obj.material);
                        if (obj.material instanceof Array) {
                            obj.material = obj.material.map(m => new THREE.MeshLambertMaterial());
                        } else {
                            obj.material = new THREE.MeshLambertMaterial();
                        }
                    }
                });
                console.log("FBX-tree", objectToTreeDebug(fbx));
                resolve(fbx);
            }
        );
    });
}

const PANE_MODE = {
    DEFAULT: 0,
    EMOTION: 1,
    IMAGE: 2,
};

/**
 * Handle main editor UI & all state. Start dialog is NOT part of this class.
 * 
 * Design:
 *  - Canonical VRM data = VrmModel
 *  - Converter = Converts "VRM data" into ViewModel quickly, realtime.
 *  - Vue data = ViewModel. Write-operation directly goes to VRM data (and notifies converter).
 * 
 * Weight: 0~1.0(vue.js/three.js) 0~100(UI/Unity/VRM). These are typical values, they can be negative or 100+.
 */
// TODO: For some reason, computed methods are called every frame. Maybe some internal property in three.js is changing
// every frame? this is not good for performance, but is acceptable for now...
class MevApplication {
    constructor(width, height, canvasInsertionParent) {
        // Three.js canvas
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(75, width / height, 0.01, 50);
        this.camera.position.set(0, 1, -3);
        this.camera.lookAt(0, 0.9, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        // Recommended gamma values from https://threejs.org/docs/#examples/loaders/GLTFLoader
        this.renderer.gammaOutput = true;  // If set, then it expects that all textures and colors need to be outputted in premultiplied gamma.
        this.renderer.gammaFactor = 2.2;
        this.renderer.setSize(width, height);
        canvasInsertionParent.appendChild(this.renderer.domElement);
        window.onresize = _event => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            this.renderer.setSize(w, h);
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        };

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);

        this.renderer.setClearColor(new THREE.Color("#f5f5f5"));
        this.scene.add(this._createStage());
        this.scene.add(new THREE.DirectionalLight(0xffffff, 1.0));
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.3));

        // Setup progress indicator
        new Mprogress({
            template: 3,
            parent: "#loading_progress",
        }).start();



        // Overlay UI
        const app = this;
        app.heightIndicator = new HeightIndicator(this.scene);

        // ID: http://mocap.cs.cmu.edu/search.php?subjectnumber=%&motion=%
        // 01_09: good complex 3D movement
        // 09_12: walk in various direction
        // 40_10: "wait for bus" movement (good for idle)
        const req = new Request("https://s3.amazonaws.com/open-motion.herokuapp.com/json/40_10.json");
        app.motionFrames = [];
        app.motionFrameIndex = 0;
        fetch(req).then(response => response.json()).then(json => {
            console.log("Motion", json);
            app.motionFrames = json.motion;
        });


        this.vm = new Vue({
            el: '#vue_menu',
            data: {
                // Global
                startedLoading: false,
                vrmRoot: null, // VrmModel

                // UI mode
                currentPane: PANE_MODE.DEFAULT,
                isFatalError: false,

                // PANE_MODE.DEFAULT
                avatarName: "",
                avatarHeight: "",
                currentEmotionId: "neutral",  // shared with PANE_MODE.EMOTION
                finalVrmSizeApprox: "",

                // PANE_MODE.IMAGE
                currentImageId: -1,
            },
            watch: {
                vrmRoot: function (newValue, oldValue) {
                    console.log("vrmRoot.watch");
                    if (newValue !== oldValue || newValue.version !== oldValue.version) {
                        console.log("Updating vrmRoot");
                        this._applyEmotion();
                        this._computeAvatarHeight();
                        this._calculateFinalSizeAsync();
                        app.heightIndicator.setHeight(this.avatarHeight);
                        app.heightIndicator.setVisible(true);
                    }
                },
            },
            methods: {
                updateVrm: function (newVrm) {
                    this.vrmRoot = newVrm;
                    app.vrmRenderer.invalidate();
                },
                refreshPage: function () {
                    location.reload();
                },
                clickEmotion: function (emotionId) {
                    if (this.currentEmotionId === emotionId) {
                        this.currentPane = PANE_MODE.EMOTION;
                    } else {
                        this.currentEmotionId = emotionId;
                        this._applyEmotion();
                    }
                },
                clickImage: function (imageId) {
                    this.currentImageId = imageId;
                    this.currentPane = PANE_MODE.IMAGE;
                },
                _applyEmotion() {
                    app.vrmRenderer.setCurrentEmotionId(this.currentEmotionId);
                    app.vrmRenderer.invalidateWeight();
                },
                _calculateFinalSizeAsync: function () {
                    this.vrmRoot.serialize().then(buffer => {
                        this.finalVrmSizeApprox = (buffer.byteLength * 1e-6).toFixed(1) + "MB";
                    });
                },
                downloadVrm: function (event) {
                    console.log("Download requested");

                    this.vrmRoot.serialize().then(buffer => {
                        saveAs(new Blob([buffer], { type: "application/octet-stream" }), "test.vrm");
                    });
                },
                clickBackButton: function () {
                    this.currentPane = PANE_MODE.DEFAULT;
                },
                _computeAvatarHeight: function () {
                    // For some reason, according to profiler,
                    // this method is computed every frame unlike others (e.g. finalVrmTris, blendshapes, parts).
                    // Maybe because this is using this.vrmRoot directly, and some filed in vrmRoot is changing every frame?
                    if (this.vrmRoot === null) {
                        return 0;
                    }
                    // TODO: Ideally, this is calculatable without Renderer.
                    this.avatarHeight = (new THREE.Box3().setFromObject(app.vrmRenderer.getThreeInstance())).getSize(new THREE.Vector3()).y;
                }
            },
            computed: {
                // Toolbar & global pane state.
                toolbarTitle: function () {
                    switch (this.currentPane) {
                        case PANE_MODE.DEFAULT:
                            return this.avatarName;
                        case PANE_MODE.EMOTION:
                            const nameToBlendshape = new Map(this.blendshapes.map(bs => [bs.id, bs]));
                            const blendshape = nameToBlendshape.get(this.currentEmotionId);
                            return "表情:" + blendshape.label;
                        case PANE_MODE.IMAGE:
                            return "画像: " + this.vrmRoot.gltf.images[this.currentImageId].name;
                        default:
                            console.error("Unknown UI mode: ", this.currentPane);
                            return "";
                    }
                },
                showBackButton: function () {
                    return this.currentPane !== PANE_MODE.DEFAULT;
                },
                showMainPane: function () {
                    return this.currentPane === PANE_MODE.DEFAULT && this.vrmRoot !== null;
                },
                showEmotionPane: function () {
                    return this.currentPane === PANE_MODE.EMOTION;
                },
                showImagePane: function () {
                    return this.currentPane === PANE_MODE.IMAGE;
                },
                isLoading: function () {
                    return this.startedLoading && (this.vrmRoot === null && !this.isFatalError);
                },

                // Main page state "converter".
                finalVrmTris: function () {
                    if (this.vrmRoot === null) {
                        return "";
                    }
                    return "△" + this.vrmRoot.countTotalTris();
                },
                allWeightCandidates: function () {
                    var candidates = [];
                    this.vrmRoot.gltf.meshes.forEach((mesh, meshIndex) => {
                        mesh.primitives.forEach(prim => {
                            if (!prim.extras) {
                                return;
                            }
                            prim.extras.targetNames.forEach((morphName, morphIndex) => {
                                candidates.push({
                                    // Maybe this can be moved to menu-section-emotion?
                                    mesh: app.vrmRenderer.getMeshByIndex(meshIndex),
                                    meshIndex: meshIndex,
                                    morphIndex: morphIndex,
                                    morphName: morphName,
                                });
                            });
                        });
                    });
                    return candidates;
                },
                blendshapeMaster: function () {
                    if (this.vrmRoot === null) {
                        return null;
                    }
                    return this.vrmRoot.gltf.extensions.VRM.blendShapeMaster;
                },
                // Deprecated: Use emotionGroups
                blendshapes: function () {
                    if (this.vrmRoot === null) {
                        return [];
                    }
                    this.vrmRoot.version;

                    return this.vrmRoot.gltf.extensions.VRM.blendShapeMaster.blendShapeGroups.map(bs => {
                        const binds = bs.binds.map(bind => {
                            const mesh = this.vrmRoot.gltf.meshes[bind.mesh];
                            return {
                                meshName: mesh.name,
                                meshIndex: bind.mesh,
                                morphName: mesh.primitives[0].extras.targetNames[bind.index],
                                morphIndex: bind.index,
                                weight: bind.weight,
                            };
                        });
                        return {
                            id: blendshapeToEmotionId(bs),
                            label: bs.presetName !== "unknown" ? EMOTION_PRESET_NAME_TO_LABEL[bs.presetName] : bs.name,
                            presetName: bs.presetName,  // "unknown" can appear more than once
                            weightConfigs: binds,
                        };
                    });
                },
                emotionGroups: function () {
                    if (this.vrmRoot == null) {
                        return [];
                    }

                    const knownNames = new Set(flatten(EMOTION_PRESET_GROUPING));

                    const nameToBlendshape = new Map(this.blendshapes.map(bs => [bs.presetName, bs]));
                    const groups = EMOTION_PRESET_GROUPING.map(defaultGroupDef => {
                        return defaultGroupDef.map(name => {
                            if (nameToBlendshape.has(name)) {
                                const bs = nameToBlendshape.get(name);
                                return {
                                    id: bs.id,
                                    label: bs.label,
                                    weightConfigs: bs.weightConfigs,
                                };
                            } else {
                                console.warn("The VRM is missing standard blendshape preset: " + name + ". Creating new one.");
                                return {
                                    id: name,
                                    label: EMOTION_PRESET_NAME_TO_LABEL[name],
                                    weightConfigs: [],
                                };
                            }
                        });
                    }
                    );
                    const unknownGroup = [];
                    this.blendshapes.forEach(bs => {
                        if (knownNames.has(bs.presetName)) {
                            return;
                        }
                        // All unknown blendshape presetName must be unknown.
                        if (bs.presetName !== "unknown") {
                            console.warn("Non-comformant emotion preset name found, treating as 'unknown'", bs.presetName)
                        }

                        unknownGroup.push({
                            id: bs.id,
                            label: bs.label,
                            weightConfigs: bs.weightConfigs,
                        });
                    });
                    if (unknownGroup.length > 0) {
                        groups.push(unknownGroup);
                    }
                    return groups;
                },
                currentWeightConfigs: function () {
                    const nameToBlendshape = new Map(this.blendshapes.map(bs => [bs.id, bs]));
                    const blendshape = nameToBlendshape.get(this.currentEmotionId);
                    return blendshape ? blendshape.weightConfigs : [];
                },
                springs: function () {
                    if (this.vrmRoot === null) {
                        return [];
                    }
                    const secAnim = this.vrmRoot.gltf.extensions.VRM.secondaryAnimation;
                    return (secAnim.boneGroups.concat(secAnim.colliderGroups)).map(g => JSON.stringify(g));
                },
                parts: function () {
                    if (this.vrmRoot === null) {
                        return [];
                    }
                    this.vrmRoot.version; // force depend

                    const parts = [];
                    this.vrmRoot.gltf.meshes.forEach((mesh, meshIx) => {
                        mesh.primitives.forEach((prim, primIx) => {
                            const mat = this.vrmRoot.gltf.materials[prim.material];
                            const part = {
                                visibility: true,
                                // (meshIx, primIx) act as VRM-global prim id.
                                meshIx: meshIx,
                                primIx: primIx,
                                name: mesh.name + ":" + primIx,
                                shaderName: MevApplication._getShaderNameFromMaterial(this.vrmRoot, prim.material),
                                imageId: -1,
                                textureUrl: null,
                                numTris: "△" + this.vrmRoot.countPrimitiveTris(prim),
                            };

                            if (mat.pbrMetallicRoughness.baseColorTexture !== undefined) {
                                const texId = mat.pbrMetallicRoughness.baseColorTexture.index;
                                const imageId = this.vrmRoot.gltf.textures[texId].source;
                                part.imageId = imageId;
                                part.textureUrl = this.vrmRoot.getImageAsDataUrl(imageId);
                            }

                            parts.push(part);
                        });
                    });
                    return parts;
                },
                partsForCurrentImage: function () {
                    return this.parts.filter(part => part.imageId === this.currentImageId);
                },
                vrmRenderer: function () {
                    return app.vrmRenderer;
                },
            },
        });
    }

    /** Executes and renders single frame and request next frame. */
    animate() {
        this.controls.update();

        // Get single frame from cyclic motion frames
        if (this.motionFrameIndex >= this.motionFrames.length) {
            this.motionFrameIndex = 0;
        }
        const currentMotion = this.motionFrames[this.motionFrameIndex];
        if (this.motionFrameIndex === 100 && this.motionFrames.length > 0) {
            console.log("Motion frame example:", currentMotion);
        }
        this.motionFrameIndex += 2;

        // TODO: apply
        if (this.vm.vrmRoot && this.vrmRenderer) {
            const inst = this.vrmRenderer.getThreeInstance();

            // Motion data -> VRM humanoid bone name
            const lrMapping = new Map([
                ["clavicle", "Shoulder"], // almost 0
                ["humerus", "UpperArm"],
                ["radius", "LowerArm"], // {rx}
                ["wrist", "Hand"],
                ["femur", "UpperLeg"],
                ["tibia", "LowerLeg"],
                ["foot", "Foot"],
                ["toes", "Toes"],

                ["thumb", "ThumbProximal"],
            ]);
            const mapping = new Map([
                ["root", "hips"],
                ["thorax", "chest"],
                ["lowerneck", "neck"], // upperneck??
                ["head", "head"],
            ]);
            lrMapping.forEach((vrmName, motionName) => {
                mapping.set("l" + motionName, "left" + vrmName);
                mapping.set("r" + motionName, "right" + vrmName);
            });

            const vrmNameToNodeIndex =
                new Map(this.vm.vrmRoot.gltf.extensions.VRM.humanoid.humanBones.map(bone => [bone.bone, bone.node]));


            // Coordinate Systems:
            // VRM/three: https://gyazo.com/19731bf972cdd0fee866ee03d8634785
            // ASF/AMC: https://gyazo.com/6e8f786af0028d6effcb6bb77202b428

            if (inst !== null) {
                mapping.forEach((boneName, asfName) => {
                    const nodeIndex = vrmNameToNodeIndex.get(boneName);
                    const bone = this.vrmRenderer.getNodeByIndex(nodeIndex);
                    const val = currentMotion[asfName];
                    if (!bone) {
                        return;
                    }
                    if (!bone || !val) {
                        console.log("Not found", boneName, bone, asfName, val);
                        return;
                    }

                    if (asfName === "root") {
                        bone.position.set(-val.tx, val.ty, -val.tz);
                    }

                    if (boneName.includes("UpperArm")) {
                        const xz = new THREE.Vector2(val.rx, val.rz);

                        const clavicleRot = 0.40; // from sekelton.rclavicle (XY)
                        const isq2 = 1 / Math.sqrt(2);

                        if (boneName === "rightUpperArm") {
                            const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, isq2, isq2), val.rx);
                            const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(-1, 0, 0), val.ry);
                            const qZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, -isq2, isq2), val.rz);
                            const boneDeltaRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), clavicleRot);
    
                            qZ.multiply(qY);
                            qZ.multiply(qX);
                            qZ.multiply(boneDeltaRot);
    
                            bone.quaternion.copy(qZ);
                        } else {
                            const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, -isq2, -isq2), val.rx);
                            const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), val.ry);
                            const qZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, -isq2, isq2), val.rz);
                            const boneDeltaRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -clavicleRot);
    
                            qZ.multiply(qY);
                            qZ.multiply(qX);
                            qZ.multiply(boneDeltaRot);
    
                            bone.quaternion.copy(qZ);
                        }
                    } else if (boneName.includes("leftLowerArm")) {
                        bone.quaternion.setFromEuler(new THREE.Euler(0, -val.rx, 0, "ZYX"));
                    } else if (boneName.includes("rightLowerArm")) {
                        bone.quaternion.setFromEuler(new THREE.Euler(0, val.rx, 0, "ZYX"));
                    } else if (boneName.includes("UpperLeg")) {
                        const legRotationZ = 0.350; // from skeleton.lfemur
                        bone.quaternion.multiplyQuaternions(
                            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), boneName === "leftUpperLeg" ? -legRotationZ : legRotationZ),
                            new THREE.Quaternion().setFromEuler(new THREE.Euler(-val.rx, val.ry, -val.rz, "ZYX"))
                        );
                    } else if (boneName.includes("Foot") || boneName.includes("Toes")) {
                        bone.quaternion.setFromEuler(new THREE.Euler(-val.rx, val.rz, val.ry, "ZYX"));
                    } else {
                        bone.quaternion.setFromEuler(new THREE.Euler(-val.rx || 0, val.ry || 0, -val.rz || 0, "ZYX"));
                    }
                });

                // "lowerback", "upperback" -> "spine"
                {
                    const nodeIndex = vrmNameToNodeIndex.get("spine");
                    const bone = this.vrmRenderer.getNodeByIndex(nodeIndex);

                    const lowerBackV = currentMotion["lowerback"];
                    const lowerBackQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-lowerBackV.rx || 0, lowerBackV.ry || 0, -lowerBackV.rz || 0, "ZYX"));
                    const upperBackV = currentMotion["upperback"];
                    const upperBackQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-upperBackV.rx || 0, upperBackV.ry || 0, -upperBackV.rz || 0, "ZYX"));

                    bone.quaternion.multiplyQuaternions(upperBackQ, lowerBackQ);
                }


            }
        }





        this.renderer.render(this.scene, this.camera);

        requestAnimationFrame(() => this.animate());
    }

    // It's very clear now that we need somewhat complex FBX -> VRM converter (even some UI to resolve ambiguity).
    // For now, assume FBX load show some object in the scene (sometimes) but UI functionality is broken because
    // its vrmRoot object lack VRM structure.
    loadFbxOrVrm(vrmFile) {
        const isFbx = vrmFile.name.toLowerCase().endsWith('.fbx');
        this.vm.startedLoading = true;

        const vrmExtIndex = vrmFile.name.toLowerCase().lastIndexOf(".vrm");
        this.vm.avatarName = vrmExtIndex >= 0 ? vrmFile.name.substr(0, vrmExtIndex) : vrmFile.name;

        // three-vrm currently doesn't have .parse() method, need to convert to data URL...
        // (inefficient)
        const reader = new FileReader();
        const app = this;
        const scene = this.scene;
        if (isFbx) {
            // Not supported
        } else {
            // VRM
            reader.addEventListener("load", () => {
                VrmModel.deserialize(reader.result).then(vrmModel => {
                    app.vrmRenderer = new VrmRenderer(vrmModel);  // Non-Vue binder of vrmModel.
                    app.vrmRenderer.getThreeInstanceAsync().then(instance => {

                        instance.traverse(o => {
                            if (o.type === "Bone") {
                                //o.add(new THREE.AxesHelper(0.3));
                            }

                        });


                        this.scene.add(instance);
                        // Ideally, this shouldn't need to wait for instance.
                        // But current MevApplication VM depends A LOT on Three instance...
                        app.vm.vrmRoot = vrmModel; // Vue binder of vrmModel.
                    });
                });
            });
            reader.readAsArrayBuffer(vrmFile);
        }
    }

    /**
     * Creates visual tree that connects parent.position & child.position for all parent-child pairs.
     * Useful for bone visualization.
     */
    createTreeVisualizer(obj) {
        const geom = new THREE.Geometry();
        function traverse(o) {
            const p0 = o.getWorldPosition(new THREE.Vector3());
            o.children.forEach(c => {
                if (c.type === "Bone" && o.type === "Bone") {
                    const p1 = c.getWorldPosition(new THREE.Vector3());
                    geom.vertices.push(p0);
                    geom.vertices.push(p1);
                }
                traverse(c);
            });
        }
        traverse(obj);
        const mat = new THREE.LineBasicMaterial({ color: "red" });
        mat.depthTest = false;
        return new THREE.LineSegments(geom, mat);
    }

    static _getShaderNameFromMaterial(vrm, matIx) {
        const mat = vrm.gltf.materials[matIx];
        if (mat.extensions !== undefined && mat.extensions.KHR_materials_unlit !== undefined) {
            const vrmShader = vrm.gltf.extensions.VRM.materialProperties[matIx].shader;
            if (vrmShader === "VRM_USE_GLTFSHADER") {
                return "Unlit*";
            } else {
                return vrmShader;
            }
        } else {
            return "Metallic-Roughness";
        }
    }

    static _convertImageToDataUrlWithHeight(img, targetHeight) {
        const scaling = targetHeight / img.height;
        const targetWidth = Math.floor(img.width * scaling);

        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, targetWidth, targetHeight);
        return canvas.toDataURL("image/png");
    }

    /**
     * Creates circular stage with:
     * - normal pointing Y+ ("up" in VRM spec & me/v app)
     * - notch at Z-. ("front" in VRM spec)
     */
    _createStage() {
        const stageGeom = new THREE.CircleBufferGeometry(1, 64);
        const stageMat = new THREE.MeshBasicMaterial({ color: "white" });
        const stageObj = new THREE.Mesh(stageGeom, stageMat);
        stageObj.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 1.5);

        const notchGeom = new THREE.CircleBufferGeometry(0.02, 16);
        const notchMat = new THREE.MeshBasicMaterial({ color: "grey" });
        const notchObj = new THREE.Mesh(notchGeom, notchMat);
        notchObj.position.set(0, 0.95, 0.001);

        stageObj.add(notchObj);
        return stageObj;
    }
}

/// Present current avatar height in Scene.
/// Hidden by default.
class HeightIndicator {
    constructor(scene) {
        this.scene = scene;

        this.visible = false;
        this._createObjects(0);
    }

    setVisible(visible) {
        this.visible = visible;

        this.arrow.visible = visible;
        this.sprite.visible = visible;
    }

    setHeight(height) {
        this.scene.remove(this.arrow);
        this.scene.remove(this.sprite);
        this._createObjects(height);
    }

    _createObjects(height) {
        // Arrow
        {
            const geom = new THREE.Geometry();
            geom.vertices.push(new THREE.Vector3(0, height, 0));
            geom.vertices.push(new THREE.Vector3(-0.5, height, 0));
            const mat = new THREE.LineBasicMaterial({ color: "black" });

            this.arrow = new THREE.LineSegments(geom, mat);
            this.arrow.visible = this.visible;
            this.scene.add(this.arrow);
        }

        // Text
        {
            const canvas = document.createElement("canvas");
            canvas.width = 128;
            canvas.height = 128;
            const ctx = canvas.getContext("2d");
            ctx.fillColor = "black";
            ctx.font = "32px Roboto";
            ctx.fillText(height.toFixed(2) + "m", 0, 32);

            const tex = new THREE.CanvasTexture(canvas);
            const mat = new THREE.SpriteMaterial({ map: tex });
            const sprite = new THREE.Sprite(mat);
            sprite.scale.set(0.25, 0.25, 0.25);
            sprite.position.set(-0.5, height - 0.05, 0);

            this.sprite = sprite;
            this.sprite.visible = this.visible;
            this.scene.add(this.sprite);
        }
    }
}

function main() {
    const app = new MevApplication(window.innerWidth, window.innerHeight, document.body);
    setupStartDialog(file => {
        document.getElementById("vue_menu").style.display = "";
        app.loadFbxOrVrm(file);
    });
    app.animate();
}

main();