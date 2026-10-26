/**
 * Proxmox hosts and guests as Helm records them (1110): the config-string
 * parsing, and what each kind of machine becomes.
 */
import { describe, expect, it } from 'vitest';
import {
  disksFor, latestBackups, mapGuest, mapNode, nicsFor, osFor, parsePveList, pveVersionOf, sizeToGb,
} from '../../src/lib/proxmox/machines';

describe('Proxmox config strings', () => {
  it('reads key=value lists, keeping a bare volume under the empty key', () => {
    expect(parsePveList('local-lvm:vm-100-disk-0,iothread=1,size=32G')).toEqual({
      '': 'local-lvm:vm-100-disk-0', iothread: '1', size: '32G',
    });
    expect(parsePveList(undefined)).toEqual({});
  });

  it('reads sizes in any unit as GB', () => {
    expect(sizeToGb('32G')).toBe(32);
    expect(sizeToGb('512M')).toBe(0.5);
    expect(sizeToGb('2T')).toBe(2048);
    expect(sizeToGb('nonsense')).toBeNull();
  });

  it('lists a VM\'s NICs in order, with MAC, bridge and VLAN', () => {
    expect(nicsFor('qemu', {
      net1: 'e1000=BC:24:11:00:00:02,bridge=vmbr1',
      net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1,tag=20',
    })).toEqual([
      { name: 'net0', model: 'virtio', mac: 'bc:24:11:00:00:01', bridge: 'vmbr0', vlan: '20' },
      { name: 'net1', model: 'e1000', mac: 'bc:24:11:00:00:02', bridge: 'vmbr1' },
    ]);
  });

  it('takes a container\'s static address from its config, and not "dhcp"', () => {
    expect(nicsFor('lxc', {
      net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:03,ip=10.0.0.6/24,gw=10.0.0.1,type=veth',
      net1: 'name=eth1,bridge=vmbr1,hwaddr=BC:24:11:00:00:04,ip=dhcp',
    })).toEqual([
      { name: 'eth0', mac: 'bc:24:11:00:00:03', bridge: 'vmbr0', addresses: ['10.0.0.6'] },
      { name: 'eth1', mac: 'bc:24:11:00:00:04', bridge: 'vmbr1' },
    ]);
  });

  it('counts disks, not CD drives, EFI or TPM volumes', () => {
    expect(disksFor('qemu', {
      scsi0: 'local-lvm:vm-100-disk-0,size=32G',
      scsi1: 'ceph:vm-100-disk-1,size=100G',
      ide2: 'local:iso/virtio-win.iso,media=cdrom,size=700M',
      efidisk0: 'local-lvm:vm-100-disk-2,size=4M',
      sata0: 'none,media=cdrom',
    })).toEqual([
      { name: 'scsi0', storage: 'local-lvm', sizeGb: 32 },
      { name: 'scsi1', storage: 'ceph', sizeGb: 100 },
    ]);
    expect(disksFor('lxc', { rootfs: 'local-lvm:vm-200-disk-0,size=8G', mp0: 'tank:subvol-200-disk-1,mp=/data,size=50G' }))
      .toEqual([
        { name: 'rootfs', storage: 'local-lvm', sizeGb: 8 },
        { name: 'mp0 (/data)', storage: 'tank', sizeGb: 50 },
      ]);
  });

  it('names Proxmox\'s OS codes and versions', () => {
    expect(osFor('l26')).toBe('Linux');
    expect(osFor('win11')).toMatch(/Windows 11/);
    expect(osFor('debian')).toBe('Debian');
    expect(osFor('somethingnew')).toBe('somethingnew');
    expect(pveVersionOf('pve-manager/8.2.4/faa83925c9641325')).toBe('8.2.4');
  });

  it('keeps the newest backup of each guest', () => {
    const latest = latestBackups([
      { vmid: 100, ctime: 1_760_000_000 }, { vmid: '100', ctime: 1_760_086_400 }, { vmid: 101, ctime: 1_750_000_000 },
    ]);
    expect(latest.get('100')).toBe(new Date(1_760_086_400_000).toISOString());
    expect(latest.get('101')).toBe(new Date(1_750_000_000_000).toISOString());
  });
});

describe('a Proxmox host', () => {
  it('is a hypervisor with its CPU, memory, address and version', () => {
    const host = mapNode({
      node: { node: 'pve1', status: 'online', maxmem: 1 },
      status: {
        cpuinfo: { model: 'AMD EPYC 7302P', sockets: 1, cores: 16, cpus: 32 },
        memory: { total: 137_438_953_472 },
        pveversion: 'pve-manager/8.2.4/faa83925c9641325',
        kversion: 'Linux 6.8.8-2-pve #1 SMP PREEMPT_DYNAMIC',
        uptime: 86_400,
      },
      cluster: [{ type: 'cluster', name: 'lake' }, { type: 'node', name: 'pve1', ip: '10.0.0.11' }],
      storage: [{ storage: 'local-lvm', node: 'pve1', plugintype: 'lvmthin', maxdisk: 1024 ** 4, disk: 1024 ** 3 * 512 }],
      guests: [{ node: 'pve1', status: 'running', vmid: 100 }, { node: 'pve1', status: 'stopped', vmid: 101 }],
    });
    expect(host).toMatchObject({
      kind: 'node', externalId: 'pve1', deviceType: 'hypervisor', hostExternalId: null,
      values: {
        hostname: 'pve1', operating_system: 'Proxmox VE', os_version: '8.2.4', cpu: 'AMD EPYC 7302P',
        memory_gb: 128, primary_ip: '10.0.0.11',
      },
      profile: {
        cluster: 'lake', kernel: 'Linux 6.8.8-2-pve', cpu: { sockets: 1, cores: 16, threads: 32 },
        guests: { running: 1, total: 2 },
        storage: [{ name: 'local-lvm', type: 'lvmthin', totalGb: 1024, usedGb: 512, shared: false }],
      },
    });
  });
});

describe('a Proxmox guest', () => {
  const resource = { type: 'qemu', vmid: 100, name: 'dc01', node: 'pve1', status: 'running', maxmem: 1, tags: 'prod;ad' };
  const config = {
    name: 'dc01', cores: 2, sockets: 2, memory: '8192', ostype: 'win11', cpu: 'x86-64-v2-AES', agent: '1', onboot: 1,
    net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0',
    scsi0: 'local-lvm:vm-100-disk-0,size=80G',
    description: 'Domain controller',
  };

  it('is a virtual machine on its host, with what its config says', () => {
    const vm = mapGuest({ resource, config });
    expect(vm).toMatchObject({
      kind: 'guest', externalId: '100', name: 'dc01', deviceType: 'virtual_machine', hostExternalId: 'pve1',
      values: {
        hostname: 'dc01', operating_system: expect.stringMatching(/Windows 11/), cpu: '4 vCPU (x86-64-v2-AES)',
        memory_gb: 8, storage_gb: 80, primary_mac: 'bc:24:11:00:00:01',
      },
      profile: { kind: 'qemu', vmid: 100, node: 'pve1', tags: ['prod', 'ad'], onBoot: true, agent: 'not_answering', notes: 'Domain controller' },
    });
    expect(vm.values.primary_ip).toBeUndefined();
  });

  it('takes the address, hostname and OS from the guest agent when it answers', () => {
    const vm = mapGuest({
      resource, config,
      agent: {
        interfaces: [
          { name: 'Loopback Pseudo-Interface 1', 'ip-addresses': [{ 'ip-address': '127.0.0.1' }] },
          { name: 'Ethernet', 'hardware-address': 'bc:24:11:00:00:01',
            'ip-addresses': [{ 'ip-address': 'fe80::1' }, { 'ip-address': '10.0.0.20' }] },
        ],
        os: { 'pretty-name': 'Windows Server 2022 Standard', 'version-id': '2022' },
        hostName: 'DC01',
      },
    });
    expect(vm.values).toMatchObject({
      hostname: 'DC01', operating_system: 'Windows Server 2022 Standard', os_version: '2022', primary_ip: '10.0.0.20',
    });
    expect(vm.profile).toMatchObject({ agent: 'answered', nics: [{ name: 'net0', addresses: ['10.0.0.20'] }] });
  });

  it('changes its hash when it moves host, and not when only its state does', () => {
    const a = mapGuest({ resource, config });
    const moved = mapGuest({ resource: { ...resource, node: 'pve2' }, config });
    const stopped = mapGuest({ resource: { ...resource, status: 'stopped' }, config });
    expect(moved.sha256.equals(a.sha256)).toBe(false);
    expect(stopped.sha256.equals(a.sha256)).toBe(true);
  });

  it('counts snapshots without the "current" placeholder', () => {
    const vm = mapGuest({
      resource, config,
      snapshots: [{ name: 'current' }, { name: 'pre-update', snaptime: 1_760_000_000 }, { name: 'old', snaptime: 1_700_000_000 }],
    });
    expect(vm.profile).toMatchObject({
      snapshots: { count: 2, latestName: 'pre-update', latestAt: new Date(1_760_000_000_000).toISOString() },
    });
  });
});
