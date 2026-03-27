import { useRef, useState, useCallback } from "react";

const DEFAULT_URL = "https://example.com/";

interface PreviewWindowProps {
  onClose: () => void;
}

export function PreviewWindow({ onClose }: PreviewWindowProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState(DEFAULT_URL);

  const handleRefresh = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = url;
    }
  }, [url]);

  const handleUrlSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (iframeRef.current) {
        iframeRef.current.src = url;
      }
    },
    [url]
  );

  return (
    <div className="fixed inset-0 z-[100] flex flex-col ide-root">
      <div className="flex items-center gap-2 px-3 py-2 border-b ide-border ide-panel-soft shrink-0">
        <button
          onClick={() => {
            if (iframeRef.current?.contentWindow) {
              iframeRef.current.contentWindow.history.back();
            }
          }}
          className="p-1.5 rounded ide-icon-button transition-colors"
          title="Atras"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <button
          onClick={() => {
            if (iframeRef.current?.contentWindow) {
              iframeRef.current.contentWindow.history.forward();
            }
          }}
          className="p-1.5 rounded ide-icon-button transition-colors"
          title="Adelante"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <button
          onClick={handleRefresh}
          className="p-1.5 rounded ide-icon-button transition-colors"
          title="Recargar"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <form onSubmit={handleUrlSubmit} className="flex-1 mx-2">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg text-sm font-mono border ide-border ide-panel ide-text focus:outline-none"
          />
        </form>

        <button
          onClick={onClose}
          className="p-1.5 rounded ide-icon-button-danger transition-colors"
          title="Cerrar navegador"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <iframe
        ref={iframeRef}
        src={DEFAULT_URL}
        className="flex-1 w-full border-none bg-white"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-navigation"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
