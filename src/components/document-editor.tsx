'use client';

/**
 * The editor for a written document (0810): Tiptap over ProseMirror, with the
 * dozen controls a runbook needs and nothing a brochure does.
 *
 * READ-ONLY IS THE SAME COMPONENT. The page renders the body through the
 * editor with editing off, so what somebody reads is exactly what the author
 * saw, and there is one renderer to keep in step with one schema.
 *
 * IMAGES ARE ATTACHMENTS. "Insert image" uploads the file as an attachment of
 * the page (encrypted, audited, downloadable like any other) and places its
 * download URL; the page owns the bytes, not the editor.
 */
import { useEffect } from 'react';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import {
  Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered,
  Minus, Quote, Redo2, Strikethrough, Undo2,
} from 'lucide-react';
import { cn } from '@/lib/ui/cn';

export type { JSONContent };

export function DocumentEditor({
  content,
  editable,
  onChange,
  onInsertImage,
}: {
  content: JSONContent;
  editable: boolean;
  onChange?: ((doc: JSONContent) => void) | undefined;
  /** Asked for a URL when the author inserts an image; the caller uploads. */
  onInsertImage?: (() => Promise<string | null>) | undefined;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: !editable, autolink: true, protocols: ['http', 'https', 'mailto'] }),
      Image.configure({ allowBase64: false }),
    ],
    content,
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => onChange?.(e.getJSON()),
    editorProps: {
      attributes: { class: 'prose-helm min-h-48 outline-none' },
    },
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  if (!editor) return <div className="min-h-48 text-sm text-ink-faint">Loading editor…</div>;

  const Tool = ({
    label, icon: Icon, active, onClick, disabled,
  }: { label: string; icon: typeof Bold; active?: boolean; onClick: () => void; disabled?: boolean }) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:opacity-40',
        active && 'bg-surface-sunken text-ink',
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );

  async function setLink() {
    const previous = editor!.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link to', previous ?? 'https://');
    if (url === null) return;
    if (url.trim() === '') {
      editor!.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor!.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  }

  async function insertImage() {
    if (!onInsertImage) return;
    const src = await onInsertImage();
    if (src) editor!.chain().focus().setImage({ src }).run();
  }

  return (
    <div className={cn('rounded-md', editable && 'border border-border')}>
      {editable && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border p-1">
          <Tool label="Heading 1" icon={Heading1} active={editor.isActive('heading', { level: 1 })}
                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
          <Tool label="Heading 2" icon={Heading2} active={editor.isActive('heading', { level: 2 })}
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
          <Tool label="Heading 3" icon={Heading3} active={editor.isActive('heading', { level: 3 })}
                onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
          <span className="mx-1 h-5 w-px bg-border" />
          <Tool label="Bold" icon={Bold} active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
          <Tool label="Italic" icon={Italic} active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
          <Tool label="Strikethrough" icon={Strikethrough} active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} />
          <Tool label="Code" icon={Code} active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} />
          <span className="mx-1 h-5 w-px bg-border" />
          <Tool label="Bulleted list" icon={List} active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <Tool label="Numbered list" icon={ListOrdered} active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
          <Tool label="Quote" icon={Quote} active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
          <Tool label="Code block" icon={Code} active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
          <Tool label="Rule" icon={Minus} onClick={() => editor.chain().focus().setHorizontalRule().run()} />
          <span className="mx-1 h-5 w-px bg-border" />
          <Tool label="Link" icon={Link2} active={editor.isActive('link')} onClick={() => void setLink()} />
          {onInsertImage && <Tool label="Insert image" icon={ImagePlus} onClick={() => void insertImage()} />}
          <span className="mx-1 h-5 w-px bg-border" />
          <Tool label="Undo" icon={Undo2} disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} />
          <Tool label="Redo" icon={Redo2} disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} />
        </div>
      )}
      <div className={cn(editable ? 'p-3' : '')}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
