import type { Session } from "@wibly/sdk";

export type Unmount = () => void;
export type Mount = (session: Session, container: HTMLElement) => Unmount;
