import { useState, useCallback, useEffect } from "react";
import { FileExplorer } from "./components/FileExplorer";
import { Terminal } from "./components/Terminal";
import { LoginScreen } from "./components/LoginScreen";
import { PreviewWindow } from "./components/PreviewWindow";
import { ThemeCustomizer } from "./components/ThemeCustomizer";
import { applyTheme, DEFAULT_THEME, IdeTheme, loadTheme, saveTheme } from "./theme";

type RightTab = "terminal" | "theme";

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("auth_token") || "");
  const [dividerX, setDividerX] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("terminal");
  const [theme, setTheme] = useState<IdeTheme>(() => loadTheme());

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

      const onMove = (ev: MouseEvent) => {
        const pct = (ev.clientX / window.innerWidth) * 100;
        setDividerX(Math.max(20, Math.min(80, pct)));
      };
      const onUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    []
  );

  if (!token) {
    return <LoginScreen onLogin={setToken} />;
  }

  return (
    <div className={`ide-root h-full flex ${isDragging ? "select-none cursor-col-resize" : ""}`}>
      <div className="h-full overflow-hidden flex flex-col ide-panel" style={{ width: `${dividerX}%` }}>
        <FileExplorer token={token} />
      </div>

      <div className="w-1.5 cursor-col-resize ide-divider shrink-0" onMouseDown={handleDragStart} />

      <div className="h-full overflow-hidden flex flex-col ide-panel" style={{ width: `${100 - dividerX}%` }}>
        <div className="px-4 py-2 border-b ide-border ide-panel-soft flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setRightTab("terminal")}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                rightTab === "terminal" ? "ide-tab-active" : "ide-tab"
              }`}
            >
              Terminal
            </button>
            <button
              onClick={() => setRightTab("theme")}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                rightTab === "theme" ? "ide-tab-active" : "ide-tab"
              }`}
            >
              Colores
            </button>
          </div>

          <div className="flex-1" />

          <button
            onClick={() => setShowPreview(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded ide-accent text-white transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Navegador
          </button>
        </div>

        <div className="flex-1 min-h-0">
          {rightTab === "terminal" ? (
            <Terminal token={token} />
          ) : (
            <ThemeCustomizer theme={theme} onChange={setTheme} onReset={() => setTheme(DEFAULT_THEME)} />
          )}
        </div>
      </div>

      {showPreview && <PreviewWindow onClose={() => setShowPreview(false)} />}
    </div>
  );
}
