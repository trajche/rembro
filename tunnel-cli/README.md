# remotebrowser-tunnel

Tunnel your local services to a [RemoteBrowserMCP](https://github.com/anthropics/remotebrowsermcp) remote browser session. This lets the remote browser container reach your `localhost` as if it were on the same network.

## Install

```bash
npm install -g remotebrowser-tunnel
```

Or run directly with npx (no install):

```bash
npx remotebrowser-tunnel --port 3000
```

## Usage

```bash
remotebrowser-tunnel --port <port> [options]
```

### Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--port` | `-p` | *(required)* | Local port to expose |
| `--host` | `-h` | `rembro.digitalno.de` | Remote host |
| `--remote-port` | `-r` | same as `--port` | Port on the remote side |
| `--key` | `-k` | `./tunnel_key` | Path to SSH private key |
| `--ssh-port` | | `2222` | SSH port on the remote server |

### Examples

Expose your local dev server on port 3000:

```bash
remotebrowser-tunnel --port 3000
```

Expose port 8080 locally as port 3000 on the remote side:

```bash
remotebrowser-tunnel -p 8080 -r 3000
```

Use a specific SSH key:

```bash
remotebrowser-tunnel --port 3000 --key ~/.ssh/tunnel_key
```

## Getting your SSH key

The tunnel SSH key is generated during deployment. You can find it:

1. In the output of `deploy.sh` after initial setup
2. On your dashboard under **Settings → Tunnel Key**
3. On the server at `/etc/remotebrowser/tunnel_keys/`

Save the private key locally and pass its path with `--key`.

## How it works

The CLI opens an SSH reverse tunnel (`ssh -N -R`) from the remote server back to your local machine. The remote browser container connects to the forwarded port on the server, which routes traffic through the tunnel to your `localhost`.

No dependencies — just Node.js and an SSH client on your PATH.
