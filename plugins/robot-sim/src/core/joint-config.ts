// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Timeline } from "gsap";

export type JointAxis = "X" | "Y" | "Z";
export type JointType = "rotational" | "linear";

export interface JointConfig {
    name: string;
    axis: JointAxis;
    type: JointType;
    /** Degrees for rotational, distance units for linear */
    minAngle: number;
    maxAngle: number;
    defaultAngle: number;
    currentAngle: number;
    /** Sign multiplier for the joint angle: 1 (default) or -1 to reverse direction */
    direction?: 1 | -1;
}

export interface RobotModelConfig {
    modelId: string;
    displayName: string;
    kinematicRoot?: string;
    /** Node whose position becomes the world origin (robot arm base) */
    baseNode?: string;
    /** Name of the TCP (Tool Center Point) node in the GLTF scene graph */
    tcpNode?: string;
    transform: {
        scale: number;
        yUpToZUp: boolean;
    };
    cantilever?: Array<{
        name: string;
        axis: JointAxis;
        type: JointType;
        min: number;
        max: number;
        default?: number;
        /** Visual nodes to sync with this joint's transform */
        linkedVisualNodes?: string[];
    }>;
    joints: Array<{
        name: string;
        axis: JointAxis;
        type: JointType;
        min: number;
        max: number;
        default?: number;
        /** Sign multiplier: 1 (default) or -1 to reverse joint direction */
        direction?: 1 | -1;
        /** Visual nodes to sync with this joint's transform */
        linkedVisualNodes?: string[];
    }>;
    grippers?: Array<{
        name: string;
        axis: JointAxis;
        type: JointType;
        min: number;
        max: number;
        default?: number;
    }>;
}

export interface JSONKeyFrame {
    id: number;
    /** Time in milliseconds */
    time: number;
    /** Joint angles in radians */
    joints: number[];
    cartesian?: {
        position: [number, number, number];
        orientation: [number, number, number, number];
    } | null;
    io?: {
        /** Gripper state: true = closed, false = open */
        digital_output_0?: boolean;
    };
}

export interface JSONActionSequence {
    meta: {
        version: string;
        description: string;
        created: string;
        robot_type: string;
    };
    frames: JSONKeyFrame[];
}

export interface AnimationState {
    isPlaying: boolean;
    isPaused: boolean;
    currentProgress: number;
    currentKeyFrameIndex: number;
    timeline: Timeline | null;
    currentSequence: JSONActionSequence | null;
}

export interface WeldLineAction {
    meta: {
        version: string;
        description: string;
        created: string;
        robot_type: string;
        action_type: "weld_line";
    };
    weld: {
        /** Start point of the weld line in world coordinates [x, y, z] */
        start: [number, number, number];
        /** End point of the weld line in world coordinates [x, y, z] */
        end: [number, number, number];
        /** TCP travel speed along the weld line in world units per second */
        speed: number;
        /** Number of interpolation steps between start and end (default: 50) */
        steps?: number;
    };
}
