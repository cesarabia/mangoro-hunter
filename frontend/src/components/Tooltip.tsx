import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const Tooltip: React.FC<{
  content: React.ReactNode;
  delayMs?: number;
  children: React.ReactNode;
  maxWidth?: number;
}> = ({ content, delayMs = 1000, children, maxWidth = 280 }) => {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const computePos = () => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      top: Math.max(8, rect.top - 10),
      left: Math.max(8, rect.left + rect.width / 2),
    });
  };

  const scheduleOpen = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      computePos();
      setOpen(true);
    }, Math.max(0, delayMs));
  };

  const closeNow = () => {
    clearTimer();
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onScroll = () => computePos();
    const onResize = () => computePos();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  useEffect(() => () => clearTimer(), []);

  return (
    <>
      <span
        ref={anchorRef}
        style={{ display: 'inline-flex', alignItems: 'center' }}
        onMouseEnter={scheduleOpen}
        onMouseLeave={closeNow}
        onFocus={scheduleOpen}
        onBlur={closeNow}
      >
        {children}
      </span>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="tooltip"
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                transform: 'translate(-50%, -100%)',
                zIndex: 9999,
                background: '#111',
                color: '#fff',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                lineHeight: 1.35,
                maxWidth,
                boxShadow: '0 8px 18px rgba(0,0,0,0.22)',
                pointerEvents: 'none',
                whiteSpace: 'normal',
              }}
            >
              {content}
            </div>,
            document.body
          )
        : null}
    </>
  );
};
