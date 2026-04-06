// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Mesh as ChiliMesh,
    command,
    FolderNode,
    type I18nKeys,
    type IApplication,
    type ICommand,
    type IDocument,
    type INode,
    Matrix4,
    MeshGroup,
    MeshNode,
    PhongMaterial,
    PubSub,
} from "@chili3d/core";
import type * as THREE from "three";
import armConfig from "../configs/arm.json";
import cantileverConfig from "../configs/cantilever_v2.json";
import crx10iAConfig from "../configs/crx10iA.json";
import type { RobotModelConfig } from "../core/joint-config";
import { type ExtractedMeshData, RobotArm } from "../core/robot-arm";
// import { type MergedMeshData, RobotArm } from '../core/robot-arm';
import { getRobotArm, registerRobotArm, removeRobotArm } from "../core/robot-registry";

function detectModelConfig(filename: string): RobotModelConfig {
    const lower = filename.toLowerCase();
    if (lower.includes("cantilever")) return cantileverConfig as RobotModelConfig;
    else if (lower.includes("crx") && lower.includes("10ia")) return crx10iAConfig as RobotModelConfig;
    return armConfig as RobotModelConfig;
}

interface RobotDocumentNodes {
    meshMap: Map<THREE.Mesh, MeshNode>;
    allMeshNodes: MeshNode[];
}

/**
 * Creates Chili3D MeshNodes from extracted robot mesh data, so the robot
 * is natively selectable through Chili3D's existing selection system (like STEP files).
 * 
/**
 * Creates a single Chili3D MeshNode from merged robot geometry.
 * One node = one tree item = one click target.
 */
function addRobotToDocument(
    document: IDocument,
    // mergedData: MergedMeshData,
    meshDataList: ExtractedMeshData[],
    displayName: string,
): RobotDocumentNodes {
    const meshMap = new Map<THREE.Mesh, MeshNode>();
    const allMeshNodes: MeshNode[] = [];
    if (meshDataList.length === 0) return { meshMap, allMeshNodes };
    // ): MeshNode {
    // Create materials for each unique color
    const colorMaterialMap = new Map<number, string>();
    for (const data of meshDataList) {
        if (!colorMaterialMap.has(data.color)) {
            const mat = new PhongMaterial({
                document,
                name: `Robot_${data.color.toString(16).padStart(6, "0")}`,
                color: data.color,
            });
            document.modelManager.materials.push(mat);
            colorMaterialMap.set(data.color, mat.id);
        }
        // const materialIds: string[] = [];
        // for (const color of mergedData.colors) {
        //     const mat = new PhongMaterial({
        //         document,
        //         name: `Robot_${color.toString(16).padStart(6, '0')}`,
        //         color,
        //     });
        //     document.modelManager.materials.push(mat);
        //     materialIds.push(mat.id);
        // }
    }

    const folder = new FolderNode({
        // const groups = mergedData.groups.map(
        //     (g) =>
        //         new MeshGroup({
        //             start: g.start,
        //             count: g.count,
        //             materialIndex: g.materialIndex,
        //         })
        // );

        // const mesh = new ChiliMesh({
        //     meshType: 'surface',
        //     position: mergedData.position,
        //     normal: mergedData.normal,
        //     index: mergedData.index,
        //     groups,
        // });

        // const meshNode = new MeshNode({
        document,
        // mesh,
        name: displayName,
        // materialId: materialIds.length === 1 ? materialIds[0] : materialIds,
    });
    for (const data of meshDataList) {
        const mesh = new ChiliMesh({
            meshType: "surface",
            position: data.position,
            normal: data.normal,
            index: data.index,
            color: data.color,
        });

        const meshNode = new MeshNode({
            document,
            mesh,
            name: data.name,
            materialId: colorMaterialMap.get(data.color),
        });

        // Set the initial transform to the GLTF mesh's world matrix
        meshNode.transform = Matrix4.fromArray(data.worldMatrix);

        folder.add(meshNode);
        meshMap.set(data.sourceMesh, meshNode);
        allMeshNodes.push(meshNode);
    }

    document.modelManager.addNode(folder);
    // document.modelManager.addNode(meshNode);
    document.visual.update();

    // console.log(
    //     `[RobotSim] Added merged MeshNode "${displayName}" to document`
    // );
    // return meshNode;
    console.log(`[RobotSim] Added ${meshDataList.length} mesh nodes for ${displayName} to document`);
    return { meshMap, allMeshNodes };
}

function getContext(application: IApplication) {
    const view = application.activeView;
    const document = view?.document;
    if (!document || !view) return undefined;
    const visual = document.visual as any;
    return { document, view, scene: visual.scene as import("three").Scene };
}

@command({
    key: "robot.import" as any,
    icon: {
        type: "path",
        value: "icons/robot.svg",
    },
})
export class ImportRobotCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const ctx = getContext(application);
        if (!ctx) {
            PubSub.default.pub("showToast", "robot.toast.noDocument" as I18nKeys);
            return;
        }

        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".glb,.gltf";

        const file = await new Promise<File | null>((resolve) => {
            input.addEventListener("change", () => {
                resolve(input.files?.[0] ?? null);
            });
            input.addEventListener("cancel", () => resolve(null));
            input.click();
        });

        if (!file) return;

        // Remove existing robot if any
        const existing = getRobotArm(ctx.document);
        if (existing) {
            removeRobotArm(ctx.document);
        }

        const modelConfig = detectModelConfig(file.name);
        console.log(`[RobotSim] Detected model config: ${modelConfig.modelId} for file: ${file.name}`);
        const robotArm = new RobotArm(ctx.scene, modelConfig);

        try {
            await robotArm.loadModelFromFile(file);
            robotArm.setOnSceneChanged(() => ctx.view.update());
            registerRobotArm(ctx.document, robotArm);

            // Extract mesh data and create Chili3D nodes (makes robot selectable like STEP)
            const meshDataList = robotArm.extractRobotMeshData();
            const { meshMap, allMeshNodes } = addRobotToDocument(
                ctx.document,
                meshDataList,
                modelConfig.displayName,
            );
            // Extract merged mesh data and create a single Chili3D MeshNode
            // const mergedData = robotArm.extractMergedMeshData();
            // if (!mergedData) {
            //     throw new Error('No mesh data found in robot model');
            // }

            // Hide original GLTF meshes — the MeshNode now renders instead

            // const meshNode = addRobotToDocument(
            //     ctx.document,
            //     mergedData,
            //     modelConfig.displayName
            // );

            robotArm.hideGltfMeshes();

            // Wire up joint animation: when joints move, rebuild merged vertex positions
            // and update the Three.js BufferGeometry directly for smooth performance.

            robotArm.setOnMeshTransformsChanged((matrices) => {
                for (const [sourceMesh, matArray] of matrices) {
                    const meshNode = meshMap.get(sourceMesh);
                    if (meshNode) {
                        meshNode.transform = Matrix4.fromArray(matArray);
                    }
                }
            });

            // const visualContext = (ctx.document.visual as any).context;
            // robotArm.setOnJointChanged(() => {
            //     const rebuilt = robotArm.rebuildMergedPositions();
            //     if (!rebuilt) return;

            //     const visualObj = visualContext.getVisual(meshNode);
            //     if (!visualObj) return;
            //     const threeMesh = (visualObj as any).mesh;
            //     if (!threeMesh?.geometry) return;

            //     const posAttr = threeMesh.geometry.attributes.position;
            //     const normAttr = threeMesh.geometry.attributes.normal;
            //     if (posAttr) {
            //         posAttr.array.set(rebuilt.position);
            //         posAttr.needsUpdate = true;
            //     }
            //     if (normAttr) {
            //         normAttr.array.set(rebuilt.normal);
            //         normAttr.needsUpdate = true;
            //     }
            //     threeMesh.geometry.computeBoundingBox();
            // });

            // Group selection: clicking any robot part selects the whole robot
            const robotNodeSet = new Set<INode>(allMeshNodes);
            let expanding = false;
            const handleSelectionChanged = (doc: IDocument, selected: INode[]) => {
                if (expanding || doc !== ctx.document) return;
                const hasRobotPart = selected.some((n) => robotNodeSet.has(n));
                const hasAllRobotParts = allMeshNodes.every((n) => selected.includes(n));
                if (hasRobotPart && !hasAllRobotParts) {
                    expanding = true;
                    ctx.document.selection.setSelection(allMeshNodes, false);
                    expanding = false;
                }
            };
            PubSub.default.sub("selectionChanged", handleSelectionChanged);
            PubSub.default.pub("showToast", "robot.toast.imported" as I18nKeys);
        } catch (error) {
            console.error("Failed to load robot model:", error);
            PubSub.default.pub("showToast", "robot.toast.importFailed" as I18nKeys);
            robotArm.dispose();
        }
    }
}
