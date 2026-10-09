import type { Installation, InstallationQuery, InstallationStore } from '@slack/bolt';
import { tables, type Db, type Sealer } from '@spinroom/db';
import { and, eq } from 'drizzle-orm';

const { slackInstalls, slackLinks, identityLinks } = tables;
export type SlackLink = typeof slackLinks.$inferSelect;

/** One install per workspace; the bot token is sealed at rest. */
export function createInstallationStore(db: Db, sealer: Sealer): InstallationStore {
  return {
    async storeInstallation(inst: Installation) {
      const teamId = inst.team?.id;
      if (!teamId || !inst.bot?.token) throw new Error('Only workspace bot installs are supported');
      const row = {
        teamId,
        teamName: inst.team?.name ?? null,
        botTokenEnc: sealer.seal(JSON.stringify(inst)),
        botUserId: inst.bot.userId ?? null,
        installedBy: inst.user.id,
        installedAt: Date.now(),
      };
      await db.insert(slackInstalls).values(row).onConflictDoUpdate({ target: slackInstalls.teamId, set: row });
    },
    async fetchInstallation(q: InstallationQuery<boolean>) {
      const row = q.teamId ? await db.query.slackInstalls.findFirst({ where: eq(slackInstalls.teamId, q.teamId) }) : undefined;
      if (!row) throw new Error(`No Spinroom install for team ${q.teamId}`);
      return JSON.parse(sealer.open(row.botTokenEnc)) as Installation;
    },
    async deleteInstallation(q: InstallationQuery<boolean>) {
      if (q.teamId) await db.delete(slackInstalls).where(eq(slackInstalls.teamId, q.teamId));
    },
  };
}

export async function botToken(db: Db, sealer: Sealer, teamId: string): Promise<string | null> {
  const row = await db.query.slackInstalls.findFirst({ where: eq(slackInstalls.teamId, teamId) });
  if (!row) return null;
  return (JSON.parse(sealer.open(row.botTokenEnc)) as Installation).bot?.token ?? null;
}

export function createLinkStore(db: Db) {
  return {
    async forChannel(teamId: string, channelId: string) {
      return (await db.query.slackLinks.findFirst({ where: and(eq(slackLinks.teamId, teamId), eq(slackLinks.channelId, channelId)) })) ?? null;
    },
    async forRoom(roomId: string) {
      return db.select().from(slackLinks).where(eq(slackLinks.roomId, roomId));
    },
    async link(p: { teamId: string; channelId: string; roomId: string; linkedByUserId: string; linkedBySlackUser: string; timeZone: string | null }) {
      const row = { ...p, cardMessageTs: null, messagesSinceCard: 0, createdAt: Date.now() };
      await db
        .insert(slackLinks)
        .values(row)
        .onConflictDoUpdate({ target: [slackLinks.teamId, slackLinks.channelId], set: row });
    },
    async unlink(teamId: string, channelId: string) {
      await db.delete(slackLinks).where(and(eq(slackLinks.teamId, teamId), eq(slackLinks.channelId, channelId)));
    },
    async all() {
      return db.select().from(slackLinks);
    },
    async set(teamId: string, channelId: string, patch: Partial<Pick<SlackLink, 'momentsEnabled' | 'recapEnabled' | 'lastRecapAt'>>) {
      await db
        .update(slackLinks)
        .set(patch)
        .where(and(eq(slackLinks.teamId, teamId), eq(slackLinks.channelId, channelId)));
    },
    async setCard(teamId: string, channelId: string, ts: string) {
      await db
        .update(slackLinks)
        .set({ cardMessageTs: ts, messagesSinceCard: 0 })
        .where(and(eq(slackLinks.teamId, teamId), eq(slackLinks.channelId, channelId)));
    },
    async bumpMessages(teamId: string, channelId: string) {
      const l = await this.forChannel(teamId, channelId);
      if (!l) return null;
      await db
        .update(slackLinks)
        .set({ messagesSinceCard: l.messagesSinceCard + 1 })
        .where(and(eq(slackLinks.teamId, teamId), eq(slackLinks.channelId, channelId)));
      return l.messagesSinceCard + 1;
    },
    /** Slack identities of a Spinroom user (for up-next DMs). */
    async slackIdentities(userId: string) {
      return db
        .select()
        .from(identityLinks)
        .where(and(eq(identityLinks.userId, userId), eq(identityLinks.provider, 'slack')));
    },
    async touchSurface(teamId: string, slackUserId: string) {
      await db
        .update(identityLinks)
        .set({ lastSurfaceAt: Date.now() })
        .where(and(eq(identityLinks.provider, 'slack'), eq(identityLinks.teamId, teamId), eq(identityLinks.externalId, slackUserId)));
    },
  };
}
export type LinkStore = ReturnType<typeof createLinkStore>;
