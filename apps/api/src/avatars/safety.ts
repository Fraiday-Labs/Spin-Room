/**
 * FR-A13: every import runs through an image-safety check before anyone else sees it.
 * The default provider queues for human review; a hosted moderation API can implement
 * the same interface.
 */
export interface ImageSafetyProvider {
  readonly name: string;
  check(image: Buffer, ctx: { avatarId: string; ownerId: string }): Promise<'approved' | 'rejected' | 'pending'>;
}

export const manualReview: ImageSafetyProvider = {
  name: 'manual',
  async check() {
    return 'pending';
  },
};

/** Development only (refused in production by config). */
export const autoApprove: ImageSafetyProvider = {
  name: 'auto_approve',
  async check() {
    return 'approved';
  },
};
