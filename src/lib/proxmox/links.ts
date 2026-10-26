/**
 * Links into the Proxmox web UI (1110). The hash selects the resource in the
 * tree, which is how Proxmox's own UI remembers where you were; an older UI
 * that does not understand it still opens at the datacenter view.
 */
export function proxmoxResourceUrl(baseUrl: string, kind: 'node' | 'qemu' | 'lxc', id: string | number): string {
  return `${baseUrl}/#v1:0:=${encodeURIComponent(`${kind}/${id}`)}:4:::::::`;
}
