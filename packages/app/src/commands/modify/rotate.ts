// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    command,
    type IStep,
    type ITransformGizmo,
    Matrix4,
    PubSub,
    Transaction,
    VisualNode,
} from "@chili3d/core";
import { MultistepCommand } from "../multistepCommand";

@command({
    key: "modify.rotate",
    icon: "icon-rotate",
})
export class Rotate extends MultistepCommand {
    private models?: VisualNode[];
    private gizmo?: ITransformGizmo;

    getSteps(): IStep[] {
        return [];
    }

    protected override async canExcute(): Promise<boolean> {
        this.models = this.document.selection.getSelectedNodes().filter((x) => x instanceof VisualNode);
        if (this.models.length > 0) return true;

        this.controller = new AsyncController();
        this.models = await this.document.selection.pickNode("prompt.select.models", this.controller, true);

        if (this.models.length > 0) return true;
        if (this.controller.result?.status === "success") {
            PubSub.default.pub("showToast", "toast.select.noSelected");
        }
        return false;
    }

    protected override async executeSteps(): Promise<boolean> {
        const view = this.application.activeView;
        if (!view || !this.models || this.models.length === 0) return false;

        this.gizmo = view.createTransformGizmo?.(this.models, "rotate");
        if (!this.gizmo) {
            PubSub.default.pub("showToast", "toast.select.noSelected");
            return false;
        }

        try {
            PubSub.default.pub("statusBarTip", "prompt.pickNextPoint");
            await this.gizmo.waitForResult();
            return true;
        } catch {
            return false;
        }
    }

    protected executeMainTask(): void {
        if (!this.gizmo || !this.models) return;

        const transform = this.gizmo.getTransform();
        if (transform.equals(Matrix4.identity())) return;

        Transaction.execute(this.document, "excute Rotate", () => {
            this.models?.forEach((x) => {
                x.transform = x.transform.multiply(transform);
            });
            this.document.visual.update();
        });
    }

    protected override afterExecute() {
        this.gizmo?.dispose();
        this.gizmo = undefined;
        super.afterExecute();
    }
}
