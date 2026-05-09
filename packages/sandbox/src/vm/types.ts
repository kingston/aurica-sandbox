export interface SandboxVM {
  name: string;
  networkInfo?: {
    ipV4: string;
    ipV6?: string;
  };
}

export interface CreateVMOptions {
  name: string;
  distro?: 'ubuntu' | 'debian' | 'nixos';
  arch?: 'amd64' | 'arm64';
}

export interface SandboxVMProvider {
  createVM: (options: CreateVMOptions) => Promise<SandboxVM>;
  destroyVM: (name: string) => Promise<void>;
  startVM: (name: string) => Promise<SandboxVM>;
  stopVM: (name: string) => Promise<void>;
  infoVM: (name: string) => Promise<SandboxVM>;
  listVMs: () => Promise<SandboxVM[]>;
}
