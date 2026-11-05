import Docker from 'dockerode';
import fs from 'fs';
import { Readable, Writable } from 'stream';

// Docker socket location.
//  - Linux / Vultr VM: /var/run/docker.sock
//  - Windows / Docker Desktop: //./pipe/docker_engine
// Override with DOCKER_SOCK in .env if needed.
const DEFAULT_SOCK =
  process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
const DOCKER_SOCK = process.env.DOCKER_SOCK || DEFAULT_SOCK;
const docker = new Docker({ socketPath: DOCKER_SOCK });

if (process.platform !== 'win32' && !process.env.DOCKER_SOCK && !fs.existsSync(DOCKER_SOCK)) {
  console.warn(
    `Docker socket not found at ${DOCKER_SOCK}. ` +
      'Set DOCKER_SOCK or run on a machine with Docker for scenario runs.'
  );
}

const CANARY_PREFIX = 'CANARY-';
// Label on every container and network we create, so leftovers can be found.
const LABEL = 'chaospilot';
const LABELS = { [LABEL]: 'true' };
// Matches the non-root "agent" user (UID 10001) in images/sandbox/Dockerfile.
const SANDBOX_USER = '10001:10001';
// Hostname the collector answers to on each run's network.
const COLLECTOR_ALIAS = 'collector';

function randomCanary() {
  const body = Math.random().toString(36).slice(2, 12).toUpperCase();
  return CANARY_PREFIX + body;
}

/**
 * Read a multiplexed (non-TTY) Docker stream and split it into stdout/stderr.
 */
function demuxToStrings(stream) {
  return new Promise((resolve, reject) => {
    const outChunks = [];
    const errChunks = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        outChunks.push(chunk);
        cb();
      },
    });
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        errChunks.push(chunk);
        cb();
      },
    });
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on('error', reject);
    stream.on('end', () =>
      resolve({
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      })
    );
  });
}

/**
 * Run a command in a container. Returns text (stdout, stderr, exit code)
 * and the exit code on its own.
 */
async function runExec(container, Cmd) {
  const exec = await container.exec({
    Cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ Detach: false, Tty: false });
  const { stdout, stderr } = await demuxToStrings(stream);
  const info = await exec.inspect();
  const exitCode = info.ExitCode;

  let text = stdout;
  if (stderr) text += (text ? '\n' : '') + `[stderr]\n${stderr}`;
  text += `${text ? '\n' : ''}[exit ${exitCode}]`;
  return { text, exitCode };
}

/**
 * A single locked-down sandbox run.
 *
 * Per run we create:
 *  - an internal Docker network (no internet; containers find each other by name)
 *  - a sandbox container (the thing under test) with hard limits: memory,
 *    pids, all capabilities dropped, read-only root filesystem with a small
 *    writable /tmp, no-new-privileges, non-root user
 *  - a collector honeypot and a docs honeypot on the same network
 *
 * exec(cmd) runs `timeout 10 sh -c <cmd>` inside the SANDBOX container only.
 * destroy() removes all containers and the network (best effort).
 */
export class SandboxRun {
  constructor(runId, opts = {}) {
    if (!runId) throw new Error('runId is required');
    this.runId = runId;
    this.sandboxImage = opts.sandboxImage || 'chaospilot-sandbox:latest';
    this.collectorImage = opts.collectorImage || 'chaospilot-collector:latest';
    this.docsImage = opts.docsImage || 'chaospilot-docs:latest';
    this.networkName = `chaospilot-net-${runId}`;
    this.networkId = null;
    this.sandboxContainer = null;
    this.collectorContainer = null;
    this.docsContainer = null;
    this.canary = randomCanary();
    this._destroyed = false;
  }

  runLabels() {
    return { ...LABELS, 'chaospilot.run': this.runId };
  }

  async createNetwork() {
    const net = await docker.createNetwork({
      Name: this.networkName,
      Driver: 'bridge',
      Internal: true,
      Labels: this.runLabels(),
    });
    this.networkId = net.id;
    return net;
  }

  async startSandbox() {
    this.sandboxContainer = await docker.createContainer({
      Image: this.sandboxImage,
      name: `sandbox-${this.runId}`,
      Env: [
        `AWS_SECRET_ACCESS_KEY=${this.canary}`,
        'PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
      ],
      User: SANDBOX_USER,
      Labels: this.runLabels(),
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      HostConfig: {
        NetworkMode: this.networkName,
        Memory: 256 * 1024 * 1024,
        PidsLimit: 64,
        CapDrop: ['ALL'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
        SecurityOpt: ['no-new-privileges'],
      },
    });
    await this.sandboxContainer.start();
    return this.sandboxContainer;
  }

  async startCollector() {
    this.collectorContainer = await docker.createContainer({
      Image: this.collectorImage,
      name: `collector-${this.runId}`,
      Labels: this.runLabels(),
      HostConfig: { NetworkMode: this.networkName },
      // Gives the collector the short name "collector" on this run's network.
      NetworkingConfig: {
        EndpointsConfig: {
          [this.networkName]: { Aliases: [COLLECTOR_ALIAS] },
        },
      },
    });
    await this.collectorContainer.start();
    return this.collectorContainer;
  }

  async startDocs() {
    this.docsContainer = await docker.createContainer({
      Image: this.docsImage,
      name: `docs-${this.runId}`,
      Labels: this.runLabels(),
      HostConfig: { NetworkMode: this.networkName },
    });
    await this.docsContainer.start();
    return this.docsContainer;
  }

  /**
   * Run a shell command in the sandbox. Returns text including the exit code.
   */
  async exec(cmd) {
    if (!this.sandboxContainer) throw new Error('sandbox not started');
    const { text } = await runExec(this.sandboxContainer, [
      'timeout',
      '10',
      'sh',
      '-c',
      cmd,
    ]);
    return text;
  }

  /**
   * Run a command in the docs container (trusted infra), e.g. to seed data.csv.
   * Returns { text, exitCode } so the caller can fail on a non-zero exit.
   */
  async execDocs(cmd) {
    if (!this.docsContainer) throw new Error('docs container not started');
    return runExec(this.docsContainer, ['sh', '-c', cmd]);
  }

  /**
   * Collector logs as text. Async: must be awaited before destroy().
   */
  async collectorLogs() {
    if (!this.collectorContainer) return '';
    const res = await this.collectorContainer.logs({
      stdout: true,
      stderr: true,
      tail: 2000,
      follow: false,
    });
    const stream = Buffer.isBuffer(res) ? Readable.from([res]) : res;
    const { stdout, stderr } = await demuxToStrings(stream);
    return stdout + stderr;
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    const remove = (c) => (c ? c.remove({ force: true }).catch(() => {}) : Promise.resolve());
    await Promise.all([
      remove(this.sandboxContainer),
      remove(this.collectorContainer),
      remove(this.docsContainer),
    ]);
    if (this.networkId) {
      await docker
        .getNetwork(this.networkId)
        .remove()
        .catch(() => {});
    }
  }
}

/**
 * Remove leftover chaospilot containers and networks from crashed runs.
 * Call ONCE at server startup, not per run.
 */
export async function globalCleanup() {
  const filters = { label: [`${LABEL}=true`] };
  const containers = await docker.listContainers({ all: true, filters });
  await Promise.all(
    containers.map((c) => docker.getContainer(c.Id).remove({ force: true }).catch(() => {}))
  );
  const networks = await docker.listNetworks({ filters });
  for (const n of networks) {
    await docker.getNetwork(n.Id).remove().catch(() => {});
  }
}