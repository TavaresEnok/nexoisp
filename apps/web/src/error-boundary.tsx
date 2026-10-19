import { Component, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="table-empty">
      <h1 className="text-2xl font-medium">Não foi possível carregar esta consulta.</h1>
      <p>Recarregue a página para tentar novamente. Nenhuma operação remota foi realizada.</p>
      <button type="button" className="commercial-select" onClick={() => window.location.reload()}>Tentar novamente</button>
    </main>;
    return this.props.children;
  }
}
