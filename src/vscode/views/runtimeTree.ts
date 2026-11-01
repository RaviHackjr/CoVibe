// Activity-bar tree views: my runtimes + sync file overview.
import * as vscode from "vscode";
import { Engine } from "../engine";
import { RuntimeRow, listRuntimes, shortId, varySpec } from "../../libs/colabApi";
import { Tokens, tokenFresh } from "../../libs/util";

export class RuntimesProvider implements vscode.TreeDataProvider<RuntimeNode> {
  private rows: RuntimeRow[] = [];
  private readonly _ev = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._ev.event;

  constructor(private readonly engine: Engine, private readonly tokenStore: { get(): Promise<Tokens | undefined> }) {}

  refresh(): void {
    void this.reload().then(() => this._ev.fire());
  }

  private async reload(): Promise<void> {
    const t = await this.tokenStore.get();
    if (!t) {
      this.rows = [];
      return;
    }
    try {
      this.rows = await listRuntimes(t);
    } catch {
      this.rows = [];
    }
  }

  getTreeItem(node: RuntimeNode): vscode.TreeItem {
    if (node.item) {
      return node.item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.command = { command: node.commandId, title: node.label };
    return item;
  }

  async getChildren(_node?: RuntimeNode): Promise<RuntimeNode[]> {
    const t = await this.tokenStore.get();
    if (!t) {
      return [new RuntimeNode(greek("Sign in to CoVibe"), "colabPipe.login", "auth")];
    }
    if (!this.rows.length) {
      await this.reload();
    }
    if (!this.rows.length) {
      return [
        new RuntimeNode("No runtime assigned", "colabPipe.pickRuntime", "empty"),
      ];
    }
    return this.rows.map((r) => {
      const label = `${shortId(r.name)} — ${varySpec(r)}`;
      const active = this.engine.getRuntime()?.name === r.name ? " (active)" : "";
      const item = new vscode.TreeItem(label + active, vscode.TreeItemCollapsibleState.None);
      item.contextValue = "colabRuntime";
      item.command = { command: "colabPipe.connectTerminalAt", title: "", arguments: [r] };
      item.iconPath = new vscode.ThemeIcon(
        (r.runtimeSpec?.key?.variant || "").toUpperCase().includes("TPU")
          ? "flame"
          : (r.runtimeSpec?.key?.variant || "").toUpperCase().includes("GPU")
            ? "zap"
            : "server-process",
      );
      return new RuntimeNode(label, "colabPipe.connectTerminalAt", "runtime", item);
    });
  }
}

function greek(s: string): string {
  return s;
}

export class RuntimeNode {
  constructor(
    public label: string,
    public readonly commandId: string,
    public readonly kind: "runtime" | "auth" | "empty",
    public item?: vscode.TreeItem,
  ) {}
}
