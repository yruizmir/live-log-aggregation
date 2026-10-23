import { Div, Span } from "@k8slens/element-components";
import { observer } from "mobx-react";
import type { Session } from "../session.injectable";
import { updatedAgo } from "./focus-bar";

/** Whether the list follows new logs, and the keys that work in it. */
export const Footer = observer(({ session }: { readonly session: Session }) => {
  const live = session.live.get();

  return (
    <Div $flex={{ gap: "m", verticalAlign: "center" }} $className="la-footer">
      <Span $className={["la-live-dot", { "la-live-dot--on": live }]} />
      <Span $flexChild>
        {live ? `Live · every ${session.liveIntervalSeconds.get() < 60 ? `${session.liveIntervalSeconds.get()}s` : `${session.liveIntervalSeconds.get() / 60}m`} · following newest logs` : `Paused · ${updatedAgo(session.loadedAt.get(), session.now.get())}`}
      </Span>
      <Span $className="la-footer-keys">/ search · ↑ ↓ step through logs · Esc close · click or drag the histogram to zoom</Span>
    </Div>
  );
});
