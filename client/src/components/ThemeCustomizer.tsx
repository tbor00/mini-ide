import { IdeTheme, DEFAULT_THEME } from "../theme";

interface ThemeCustomizerProps {
  theme: IdeTheme;
  onChange: (theme: IdeTheme) => void;
  onReset: () => void;
}

interface ColorField {
  key: keyof IdeTheme;
  label: string;
}

const COLOR_FIELDS: ColorField[] = [
  { key: "bg", label: "Fondo" },
  { key: "panel", label: "Panel" },
  { key: "panelSoft", label: "Panel suave" },
  { key: "panelHover", label: "Hover panel" },
  { key: "border", label: "Borde" },
  { key: "text", label: "Texto" },
  { key: "muted", label: "Texto secundario" },
  { key: "accent", label: "Acento" },
  { key: "accentHover", label: "Acento hover" },
];

export function ThemeCustomizer({ theme, onChange, onReset }: ThemeCustomizerProps) {
  const updateColor = (key: keyof IdeTheme, value: string) => {
    onChange({ ...theme, [key]: value });
  };

  return (
    <div className="h-full overflow-auto p-4 ide-root">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="rounded-xl border ide-border ide-panel p-4">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold ide-text">Personalizacion de colores</h2>
              <p className="text-sm ide-muted">Se guarda automaticamente en este navegador</p>
            </div>
            <button
              onClick={onReset}
              className="px-3 py-1.5 rounded text-sm font-medium text-white"
              style={{ backgroundColor: DEFAULT_THEME.accent }}
            >
              Restaurar
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {COLOR_FIELDS.map((field) => (
              <label key={field.key} className="rounded-lg border ide-border ide-panel-soft p-3">
                <span className="block text-xs mb-2 ide-muted">{field.label}</span>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme[field.key]}
                    onChange={(e) => updateColor(field.key, e.target.value)}
                    className="h-9 w-12 p-0 border-0 bg-transparent cursor-pointer"
                  />
                  <input
                    type="text"
                    value={theme[field.key]}
                    onChange={(e) => updateColor(field.key, e.target.value)}
                    className="flex-1 px-2 py-1.5 rounded border ide-border ide-panel ide-text text-sm font-mono"
                  />
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
