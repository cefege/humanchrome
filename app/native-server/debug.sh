#!/bin/bash
# Resolve absolute path of this script's directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/dist/logs"

# Timestamp for log filenames so multiple runs don't clobber each other
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WRAPPER_LOG="${LOG_DIR}/native_host_wrapper_${TIMESTAMP}.log"

NODE_SCRIPT="${SCRIPT_DIR}/index.js"

mkdir -p "${LOG_DIR}"

echo "Wrapper script called at $(date)" > "${WRAPPER_LOG}"
echo "SCRIPT_DIR: ${SCRIPT_DIR}" >> "${WRAPPER_LOG}"
echo "LOG_DIR: ${LOG_DIR}" >> "${WRAPPER_LOG}"
echo "NODE_SCRIPT: ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "Initial PATH: ${PATH}" >> "${WRAPPER_LOG}"

# Locate the Node.js executable dynamically — Chrome's PATH may be incomplete.
NODE_EXEC=""
# 1. Try PATH-based lookup first.
if command -v node &>/dev/null; then
    NODE_EXEC=$(command -v node)
    echo "Found node using 'command -v node': ${NODE_EXEC}" >> "${WRAPPER_LOG}"
fi

# 2. Fall back to common macOS install locations.
if [ -z "${NODE_EXEC}" ]; then
    COMMON_NODE_PATHS=(
        "/usr/local/bin/node"            # Homebrew on Intel Macs / direct install
        "/opt/homebrew/bin/node"         # Homebrew on Apple Silicon
        "$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node | head -n 1)/bin/node" # NVM (latest installed)
    )
    for path_to_node in "${COMMON_NODE_PATHS[@]}"; do
        if [ -x "${path_to_node}" ]; then
            NODE_EXEC="${path_to_node}"
            echo "Found node at common path: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
            break
        fi
    done
fi

# 3. Bail with a logged error if Node still can't be found.
if [ -z "${NODE_EXEC}" ]; then
    echo "ERROR: Node.js executable not found!" >> "${WRAPPER_LOG}"
    echo "Please ensure Node.js is installed and its path is accessible or configured in this script." >> "${WRAPPER_LOG}"
    exit 1
fi

echo "Using Node executable: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
echo "Node version found by script: $(${NODE_EXEC} -v)" >> "${WRAPPER_LOG}"
echo "Executing: ${NODE_EXEC} ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "PWD: $(pwd)" >> "${WRAPPER_LOG}"

exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>> "${LOG_DIR}/native_host_stderr_${TIMESTAMP}.log"
