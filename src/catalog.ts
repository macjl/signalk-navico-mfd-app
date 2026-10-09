import { NavicoApp } from "./announcement";

export interface CatalogEntry extends NavicoApp {
  lastSeen: number;
  location: string;
}

export interface WebappHost {
  registerWebapp(
    id: string,
    options: { displayName: string; description?: string; appIcon?: string },
  ): string;
  unregisterWebapp(id: string): void;
}

export class Catalog {
  readonly entries = new Map<string, CatalogEntry>();

  constructor(private readonly host: WebappHost) {}

  observe(app: NavicoApp, now = Date.now()): void {
    const previous = this.entries.get(app.id);
    const changed =
      !previous ||
      previous.name !== app.name ||
      previous.description !== app.description ||
      previous.icon !== app.icon;
    const location = changed
      ? this.host.registerWebapp(app.id, {
          displayName: app.name,
          description: app.description,
          ...(app.icon ? { appIcon: "icon" } : {}),
        })
      : previous.location;
    this.entries.set(app.id, { ...app, lastSeen: now, location });
  }

  expire(maxAgeMs: number, now = Date.now()): void {
    for (const [id, app] of this.entries) {
      if (now - app.lastSeen >= maxAgeMs) {
        this.host.unregisterWebapp(id);
        this.entries.delete(id);
      }
    }
  }

  clear(): void {
    for (const id of this.entries.keys()) this.host.unregisterWebapp(id);
    this.entries.clear();
  }
}
