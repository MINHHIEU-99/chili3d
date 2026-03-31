// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Timeline } from "gsap";

export type JointAxis = "X" | "Y" | "Z";

export interface JointConfig {
    name: string;
    axis: JointAxis;
    minAngle: number;
    maxAngle: number;
    defaultAngle: number;
    currentAngle: number;
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

export const JOINT_AXIS_MAP: Record<string, JointAxis> = {
    base1: "Y",
    shoulder: "X",
    elbow1: "X",
    elbow2: "X",
    wrist1: "Z",
};

export const GRIPPER_AXIS_MAP: Record<string, JointAxis> = {
    gripper1: "Y",
    gripper2: "Y",
};
