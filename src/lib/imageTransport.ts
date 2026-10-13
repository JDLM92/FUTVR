/** The API transport limit is separate from the 20 MB local intake limit. */
export const MAX_ANALYSIS_IMAGE_BYTES = 10 * 1024 * 1024;

function encode(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Image processing failed.')),
      type,
      quality,
    );
  });
}

function dataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The processed image could not be opened.'));
    reader.readAsDataURL(blob);
  });
}

export async function encodeCropTransport(canvas: HTMLCanvasElement) {
  let rendered = canvas;
  let blob = await encode(rendered, 'image/png');
  if (blob.size > MAX_ANALYSIS_IMAGE_BYTES) {
    // Dense JPEG/WebP inputs can grow substantially when decoded to PNG.
    // Try compression before reducing the crop's resolution.
    for (let attempt = 0; attempt < 10 && blob.size > MAX_ANALYSIS_IMAGE_BYTES; attempt++) {
      for (const quality of [.92, .82, .72]) {
        blob = await encode(rendered, 'image/jpeg', quality);
        if (blob.size <= MAX_ANALYSIS_IMAGE_BYTES) break;
      }
      if (blob.size <= MAX_ANALYSIS_IMAGE_BYTES) break;
      const smaller = document.createElement('canvas');
      smaller.width = Math.max(1, Math.floor(rendered.width * .75));
      smaller.height = Math.max(1, Math.floor(rendered.height * .75));
      const context = smaller.getContext('2d');
      if (!context) throw new Error('Image processing is unavailable in this browser.');
      context.drawImage(rendered, 0, 0, smaller.width, smaller.height);
      rendered = smaller;
    }
  }
  if (!blob.size || blob.size > MAX_ANALYSIS_IMAGE_BYTES)
    throw new Error('The processed image is still too large. Choose a smaller screenshot or a tighter crop.');
  if (!['image/png', 'image/jpeg'].includes(blob.type))
    throw new Error('This browser could not encode a supported image format.');
  const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
  return {
    file: new File([blob], `match-frame.${extension}`, { type: blob.type }),
    url: await dataURL(blob),
    width: rendered.width,
    height: rendered.height,
  };
}
