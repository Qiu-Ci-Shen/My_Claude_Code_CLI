import { memo, useState } from 'react';

import { ImageLightbox } from '../../view/subcomponents/ChatMessageImages';

type ToolResultImage = { path?: string; data?: string; name?: string };

/**
 * Inline images attached to a tool result (e.g. Browser screenshots). Each
 * picture expands to the same fullscreen lightbox used for chat attachments.
 */
export const ToolResultImages = memo(function ToolResultImages({ images }: { images: ToolResultImage[] }) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const visible = images.filter((image): image is ToolResultImage & { data: string } =>
    typeof image?.data === 'string' && image.data.length > 0,
  );
  if (visible.length === 0) {
    return null;
  }
  const active = expandedIndex !== null ? visible[expandedIndex] : null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {visible.map((image, index) => (
          <button
            key={image.name || index}
            type="button"
            onClick={() => setExpandedIndex(index)}
            aria-label={image.name ? `Expand ${image.name}` : 'Expand image'}
            className="block overflow-hidden rounded-lg border border-border/50 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
          >
            <img
              src={image.data}
              alt={image.name || 'Tool result image'}
              className="max-h-80 max-w-full cursor-zoom-in object-contain transition-transform duration-200 hover:scale-[1.01]"
            />
          </button>
        ))}
      </div>
      {active && (
        <ImageLightbox
          src={active.data}
          alt={active.name || 'Tool result image'}
          onClose={() => setExpandedIndex(null)}
        />
      )}
    </>
  );
});
