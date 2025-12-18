import React, { useEffect, useMemo, useRef, useState } from 'react';

export type GuideStep = { guideId: string; title?: string | null; body?: string | null };
export type GuideSpec = { title?: string | null; steps: GuideStep[] };

type Anchor = { top: number; left: number; width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const GuideOverlay: React.FC<{ guide: GuideSpec | null; onClose: () => void }> = ({ guide, onClose }) => {
  const [stepIndex, setStepIndex] = useState(0);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [notFound, setNotFound] = useState(false);
  const targetRef = useRef<HTMLElement | null>(null);
  const originalStyleRef = useRef<{ outline: string; boxShadow: string; borderRadius: string } | null>(null);

  const steps = Array.isArray(guide?.steps) ? guide!.steps : [];
  const step = steps[stepIndex] || null;

  useEffect(() => {
    setStepIndex(0);
  }, [guide?.title, steps.length]);

  const cleanupHighlight = () => {
    const el = targetRef.current;
    const original = originalStyleRef.current;
    if (el && original) {
      el.style.outline = original.outline;
      el.style.boxShadow = original.boxShadow;
      el.style.borderRadius = original.borderRadius;
    }
    targetRef.current = null;
    originalStyleRef.current = null;
  };

  const updateAnchorFromTarget = () => {
    const el = targetRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setAnchor({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
  };

  useEffect(() => {
    if (!guide || !step) return;
    let cancelled = false;
    cleanupHighlight();
    setAnchor(null);
    setNotFound(false);

    const findAndHighlight = (attempt: number) => {
      if (cancelled) return;
      const el = document.querySelector(`[data-guide-id="${CSS.escape(step.guideId)}"]`) as HTMLElement | null;
      if (el) {
        targetRef.current = el;
        originalStyleRef.current = {
          outline: el.style.outline || '',
          boxShadow: el.style.boxShadow || '',
          borderRadius: el.style.borderRadius || '',
        };
        el.style.outline = '3px solid rgba(17, 17, 17, 0.85)';
        el.style.boxShadow = '0 0 0 6px rgba(17, 17, 17, 0.12)';
        el.style.borderRadius = el.style.borderRadius || '10px';
        try {
          el.scrollIntoView({ block: 'center', behavior: attempt === 0 ? 'auto' : 'smooth' });
        } catch {
          // ignore
        }
        updateAnchorFromTarget();
        setNotFound(false);
        return;
      }
      if (attempt >= 25) {
        setNotFound(true);
        return;
      }
      setTimeout(() => findAndHighlight(attempt + 1), 200);
    };

    findAndHighlight(0);
    return () => {
      cancelled = true;
      cleanupHighlight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide, step?.guideId, stepIndex]);

  useEffect(() => {
    if (!guide || !step) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [guide, step, onClose]);

  useEffect(() => {
    if (!guide || !step) return;
    const handler = () => updateAnchorFromTarget();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [guide, step?.guideId, stepIndex]);

  const cardStyle = useMemo((): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'fixed',
      zIndex: 90,
      width: 'min(360px, 92vw)',
      background: '#fff',
      border: '1px solid #eee',
      borderRadius: 12,
      padding: 12,
      boxShadow: '0 10px 30px rgba(0,0,0,0.12)',
    };
    if (!anchor) return { ...base, right: 12, bottom: 12 };
    const preferredTop = anchor.top + anchor.height + 10;
    const top = preferredTop + 180 > window.innerHeight ? anchor.top - 10 - 180 : preferredTop;
    const left = clamp(anchor.left, 12, window.innerWidth - 380);
    return { ...base, top: clamp(top, 12, window.innerHeight - 220), left };
  }, [anchor]);

  if (!guide || steps.length === 0) return null;

  const isLast = stepIndex >= steps.length - 1;
  const title = guide.title || 'Guía';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 89, pointerEvents: 'none' }}>
      <div style={{ ...cardStyle, pointerEvents: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 900 }}>{title}</div>
          <button
            onClick={onClose}
            style={{ padding: '4px 10px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}
            title="Cerrar (Esc)"
          >
            Cerrar
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
          Paso {stepIndex + 1} de {steps.length}
        </div>
        {step?.title ? <div style={{ marginTop: 8, fontWeight: 800 }}>{step.title}</div> : null}
        {step?.body ? <div style={{ marginTop: 6, fontSize: 13, color: '#333', whiteSpace: 'pre-wrap' }}>{step.body}</div> : null}
        {notFound ? (
          <div style={{ marginTop: 8, fontSize: 12, color: '#b93800' }}>
            No encontré el elemento en pantalla. Si estás en otra vista, usa “Ir a …” o abre el panel correspondiente y vuelve a intentar.
          </div>
        ) : null}
        <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={stepIndex === 0}
            style={{
              padding: '6px 10px',
              borderRadius: 10,
              border: '1px solid #ccc',
              background: '#fff',
              cursor: stepIndex === 0 ? 'not-allowed' : 'pointer',
              opacity: stepIndex === 0 ? 0.6 : 1,
            }}
          >
            Atrás
          </button>
          <button
            onClick={() => (isLast ? onClose() : setStepIndex((i) => Math.min(steps.length - 1, i + 1)))}
            style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #111', background: '#111', color: '#fff', fontWeight: 800, cursor: 'pointer' }}
          >
            {isLast ? 'Terminar' : 'Siguiente'}
          </button>
        </div>
      </div>
    </div>
  );
};

