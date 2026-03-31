// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "@chili3d/core";
import type { RobotArm } from "./robot-arm";

const robotArms = new Map<string, RobotArm>();

export function registerRobotArm(document: IDocument, arm: RobotArm): void {
    robotArms.set(document.id, arm);
}

export function getRobotArm(document: IDocument | undefined): RobotArm | undefined {
    if (!document) return undefined;
    return robotArms.get(document.id);
}

export function removeRobotArm(document: IDocument): void {
    const arm = robotArms.get(document.id);
    if (arm) {
        arm.dispose();
        robotArms.delete(document.id);
    }
}

export function hasRobotArm(document: IDocument | undefined): boolean {
    if (!document) return false;
    return robotArms.has(document.id);
}
