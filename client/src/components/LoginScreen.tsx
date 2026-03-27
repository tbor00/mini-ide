import { useState } from "react";

interface LoginScreenProps {
  onLogin: (token: string) => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (data.ok) {
        sessionStorage.setItem("auth_token", data.token);
        onLogin(data.token);
      } else {
        setError(data.error || "Credenciales incorrectas");
      }
    } catch {
      setError("Error de conexion");
    }

    setLoading(false);
  };

  return (
    <div className="h-full flex items-center justify-center ide-root">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm mx-4 p-6 border rounded-xl shadow-2xl ide-panel ide-border"
      >
        <h1 className="text-xl font-bold text-center mb-6 ide-muted">mini-ide</h1>

        {error && (
          <div className="mb-4 px-3 py-2 text-sm text-red-300 bg-red-900/40 border border-red-800 rounded-lg">
            {error}
          </div>
        )}

        <div className="mb-4">
          <label className="block text-sm mb-1 ide-muted">Usuario</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-3 py-2 rounded-lg ide-text border ide-border ide-panel-soft focus:outline-none"
            autoFocus
          />
        </div>

        <div className="mb-6">
          <label className="block text-sm mb-1 ide-muted">Contrasena</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 rounded-lg ide-text border ide-border ide-panel-soft focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2 text-white font-medium rounded-lg transition-colors ide-accent disabled:opacity-60"
        >
          {loading ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}
