import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Stroke({ size = 15, children, strokeWidth = 2, ...rest }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const LogoIcon = () => (
  <Stroke size={11} strokeWidth={2.6}>
    <path d="M3 21h18M5 21V10l5 3V10l5 3V6l4 2v13" />
  </Stroke>
);
export const SearchIcon = () => (
  <Stroke>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Stroke>
);
export const CosIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" />
  </svg>
);
export const InboxIcon = (p: P) => (
  <Stroke {...p}>
    <path d="M3 13h5l1.5 3h5l1.5-3h5" />
    <path d="M5.5 5h13L21 13v6H3v-6z" />
  </Stroke>
);
export const TerminalIcon = (p: P) => (
  <Stroke {...p}>
    <path d="m4 17 6-6-6-6M12 19h8" />
  </Stroke>
);
export const TasksIcon = () => (
  <Stroke>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" />
  </Stroke>
);
export const BoardIcon = () => (
  <Stroke>
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="10" y="4" width="5" height="10" rx="1.5" />
    <rect x="17" y="4" width="4" height="13" rx="1.5" />
  </Stroke>
);
export const RunsIcon = () => (
  <Stroke>
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </Stroke>
);
export const WorkflowsIcon = () => (
  <Stroke>
    <rect x="3" y="3" width="7" height="7" rx="2" />
    <rect x="14" y="14" width="7" height="7" rx="2" />
    <path d="M10 6.5h4a3 3 0 0 1 3 3V14" />
  </Stroke>
);
export const TriggersIcon = () => (
  <Stroke>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
  </Stroke>
);
export const AgentsIcon = () => (
  <Stroke>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </Stroke>
);
export const SettingsIcon = () => (
  <Stroke>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </Stroke>
);
export const PlusIcon = (p: P) => (
  <Stroke size={13} strokeWidth={2.2} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Stroke>
);
export const CloseIcon = ({ size = 15 }: { size?: number }) => (
  <Stroke size={size}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Stroke>
);
export const ChevronDown = ({ size = 11 }: { size?: number }) => (
  <Stroke size={size} strokeWidth={2.2}>
    <path d="m6 9 6 6 6-6" />
  </Stroke>
);
export const ChevronRight = ({ open, size = 12 }: { open?: boolean; size?: number }) => (
  <Stroke size={size} strokeWidth={2.4} className="lx-chev" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
    <path d="m9 6 6 6-6 6" />
  </Stroke>
);
export const MoreIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="19" cy="12" r="1.7" />
  </svg>
);
export const FileIcon = () => (
  <Stroke size={14}>
    <path d="M14 3v5h5M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
  </Stroke>
);
export const ToolIcon = () => (
  <Stroke size={14}>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />
  </Stroke>
);
export const InfoIcon = () => (
  <Stroke size={14}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8h.01M11 12h1v4h1" />
  </Stroke>
);
export const NoteIcon = () => (
  <Stroke size={14}>
    <path d="M4 4h16v12H8l-4 4z" />
  </Stroke>
);
export const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </svg>
);
export const LinkIcon = () => (
  <Stroke>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Stroke>
);
export const CopyIcon = () => (
  <Stroke size={13}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Stroke>
);

/* ---- Status circles (14px, Linear style) ---- */

export const DoneCircle = ({ label = 'Done' }: { label?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-label={label} role="img">
    <circle cx="7" cy="7" r="6.5" fill="#5E6AD2" />
    <path d="m4.2 7.2 1.9 1.9 3.8-4" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const FailCircle = ({ label = 'Failed' }: { label?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-label={label} role="img">
    <circle cx="7" cy="7" r="6.5" fill="#E5484D" />
    <path d="m4.8 4.8 4.4 4.4M9.2 4.8 4.8 9.2" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const LiveCircle = ({ label = 'In progress', color = '#F2C94C' }: { label?: string; color?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-label={label} role="img">
    <circle cx="7" cy="7" r="6" fill="none" stroke={color} strokeWidth="1.6" />
    <path d="M7 3.2a3.8 3.8 0 0 1 0 7.6z" fill={color} />
  </svg>
);
export const WaitCircle = ({ label = 'Waiting for you' }: { label?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-label={label} role="img">
    <circle cx="7" cy="7" r="6" fill="none" stroke="#5E6AD2" strokeWidth="1.6" />
    <path d="M7 7V3.2A3.8 3.8 0 1 1 3.2 7z" fill="#5E6AD2" />
  </svg>
);
export const StuckCircle = ({ label = 'Stuck' }: { label?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-label={label} role="img">
    <circle cx="7" cy="7" r="6.5" fill="#E5484D" />
    <path d="M7 3.8v3.7M7 9.9v.2" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const TodoCircle = ({ label = 'Not started', dashed }: { label?: string; dashed?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-label={label} role="img">
    <circle cx="7" cy="7" r="6" fill="none" stroke="#B4B5BD" strokeWidth="1.6" strokeDasharray={dashed ? '2.2 2' : undefined} />
  </svg>
);
export const StoppedCircle = ({ label = 'Stopped' }: { label?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-label={label} role="img">
    <circle cx="7" cy="7" r="6" fill="none" stroke="#8A8A93" strokeWidth="1.6" />
    <path d="M4.6 9.4 9.4 4.6" stroke="#8A8A93" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const CheckToast = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="7" cy="7" r="6.5" fill="#4CB782" />
    <path d="m4.2 7.2 1.9 1.9 3.8-4" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
