export interface FleetLease {
  agent: string;
  profile: string;
  lastSeen: number;
}

export class FleetLeases {
  private readonly leases = new Map<string, FleetLease>();

  constructor(
    private readonly idleTtlSec: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  acquire(agent: string, profile: string): { ok: true } | { ok: false; heldBy: string } {
    const existing = this.leases.get(profile);
    if (existing && existing.agent !== agent && this.isLive(existing)) {
      return { ok: false, heldBy: existing.agent };
    }
    this.leases.set(profile, { agent, profile, lastSeen: this.now() });
    return { ok: true };
  }

  acquireFromPool(agent: string, label: string, candidates: string[]): string | null {
    const ordered = [...candidates].sort();
    for (const profile of ordered) {
      const existing = this.leases.get(profile);
      if (existing?.agent === agent && this.isLive(existing)) return profile;
    }
    for (const profile of ordered) {
      const existing = this.leases.get(profile);
      if (!existing || !this.isLive(existing)) {
        this.leases.set(profile, { agent, profile, lastSeen: this.now() });
        return profile;
      }
    }
    return null;
  }

  touch(agent: string, profile: string): void {
    const existing = this.leases.get(profile);
    if (existing?.agent === agent) existing.lastSeen = this.now();
  }

  release(agent: string): string[] {
    const released: string[] = [];
    for (const [profile, lease] of this.leases) {
      if (lease.agent === agent) {
        this.leases.delete(profile);
        released.push(profile);
      }
    }
    return released.sort();
  }

  sweep(): FleetLease[] {
    const expired: FleetLease[] = [];
    for (const [profile, lease] of this.leases) {
      if (!this.isLive(lease)) {
        expired.push({ ...lease });
        this.leases.delete(profile);
      }
    }
    return expired;
  }

  list(): FleetLease[] {
    return [...this.leases.values()]
      .map((lease) => ({ ...lease }))
      .sort((a, b) => a.profile.localeCompare(b.profile));
  }

  private isLive(lease: FleetLease): boolean {
    return this.now() - lease.lastSeen < this.idleTtlSec * 1000;
  }
}
