import { SpinroomError } from '@spinroom/contracts';
import sharp from 'sharp';

export const PHOTO_SIZE = 256;

/**
 * Normalise an uploaded profile photo: honour EXIF rotation, centre-crop to a square,
 * shrink to 256×256 and re-encode as WebP. Re-encoding drops all metadata (GPS, camera).
 */
export async function processPhoto(input: Buffer): Promise<Buffer> {
  try {
    return await sharp(input, { limitInputPixels: 50_000_000, animated: false })
      .rotate()
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new SpinroomError('unsupported_image', 'That file isn’t an image we can read. Try a JPEG, PNG or WebP photo.');
  }
}
