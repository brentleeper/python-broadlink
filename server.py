import os
import json
import threading

# Replace
import werkzeug

# With
from werkzeug.utils import secure_filename
from flask import Flask, request, jsonify
from flasgger import Swagger

import broadlink
from lib.broadlink_controller import BroadlinkController
from lib.custom_device import CustomDevice

app = Flask(__name__)
swagger = Swagger(app, config={
    "headers": [],
    "specs": [
        {
            "endpoint": "apispec",
            "route": "/apispec.json",
            "rule_filter": lambda rule: True,
            "model_filter": lambda tag: True,
        }
    ],
    "static_url_path": "/flasgger_static",
    "swagger_ui": True,
    "specs_route": "/"
})

CONFIG_PATH = "local/config.json"

controllers = dict()
custom_devices = dict()
_custom_device_registry = dict()


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------
DEFAULT_RF_FREQUENCY = 433.92

def save_config():
    config = {
        "controllers": {
            name: {
                "local_ip": ctrl.local_ip,
                "rf_frequency": ctrl.rf_frequency if ctrl.rf_frequency is not None else DEFAULT_RF_FREQUENCY
            }
            for name, ctrl in controllers.items()
        },
        "custom_devices": {
            device_name: controller_name
            for device_name, (_, controller_name) in _custom_device_registry.items()
        }
    }
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)


def load_config():
    if not os.path.exists(CONFIG_PATH):
        print("[startup] No saved config found, starting fresh.")
        return

    try:
        with open(CONFIG_PATH, "r") as f:
            content = f.read().strip()
            if not content:
                print("[startup] Config file is empty, starting fresh.")
                return
            config = json.loads(content)
    except json.JSONDecodeError as e:
        print(f"[startup] Config file is corrupted, starting fresh: {e}")
        return

    for name, ctrl_data in config.get("controllers", {}).items():
        try:
            controller = BroadlinkController(
                local_ip=ctrl_data["local_ip"],
                rf_frequency=ctrl_data["rf_frequency"]
            )
            controllers[name] = controller
            print(f"[startup] Restored controller: {name} ({ctrl_data['local_ip']})")
        except Exception as e:
            print(f"[startup] Failed to restore controller '{name}': {e}")

    for device_name, controller_name in config.get("custom_devices", {}).items():
        try:
            device_file = f"local/custom_devices/{device_name}"  # removed .device append
            if controller_name not in controllers:
                print(f"[startup] Skipping '{device_name}': controller '{controller_name}' not available")
                continue
            if not os.path.exists(device_file):
                print(f"[startup] Skipping '{device_name}': .device file not found")
                continue
            custom_device = CustomDevice(controllers[controller_name], device_file)
            custom_devices[device_name] = custom_device
            _custom_device_registry[device_name] = (custom_device, controller_name)
            print(f"[startup] Restored device: {device_name} -> {controller_name}")
        except Exception as e:
            print(f"[startup] Failed to restore device '{device_name}': {e}")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/send_command', methods=['GET'])
def send_command():
    """
    Send an IR/RF command to a registered custom device.
    ---
    parameters:
      - name: custom_device_name
        in: query
        type: string
        required: true
        description: Name of the custom device (without .device extension)
      - name: command
        in: query
        type: string
        required: true
        description: Command name to send
    responses:
      200:
        description: Command sent successfully
      400:
        description: Missing or invalid command
      404:
        description: Device not found
    """
    command = request.args.get('command')
    custom_device_name = f"{request.args.get('custom_device_name')}.device"

    if custom_device_name not in custom_devices:
        return f"custom device '{request.args.get('custom_device_name')}' not found", 404

    selected_custom_device: CustomDevice = custom_devices.get(custom_device_name)

    if not command:
        return "Missing 'command' parameter", 400
    if command not in selected_custom_device.get_commands():
        return f"Invalid command: {command}", 400

    selected_custom_device.send_command(command)
    return "Command sent successfully", 200


@app.route("/register_controller", methods=["GET"])
def register_controller():
    """
    Register a Broadlink IR/RF controller.
    ---
    parameters:
      - name: local_ip
        in: query
        type: string
        required: true
        description: Local IP address of the Broadlink device
      - name: rf_frequency
        in: query
        type: number
        required: true
        description: "RF frequency in MHz (e.g. 433.92)"
      - name: name
        in: query
        type: string
        required: false
        description: "Controller name, required if registering more than one (default: primary)"
    responses:
      200:
        description: Controller registered successfully
      400:
        description: Name required when registering more than one controller
    """
    local_ip = request.args.get("local_ip")
    rf_frequency = float(request.args.get("rf_frequency"))
    name = request.args.get("name")

    if not name and len(controllers) > 1:
        return "'name' parameter required when registering more than one controller", 400
    elif not name:
        name = "primary"

    controller = BroadlinkController(local_ip=local_ip, rf_frequency=rf_frequency)
    controllers[name] = controller
    save_config()

    return f"controller '{name}' registered successfully", 200


@app.route("/list_controllers", methods=["GET"])
def list_controllers():
    """
    List all registered controllers.
    ---
    responses:
      200:
        description: Comma-separated list of controller names
      404:
        description: No controllers registered
    """
    if not controllers:
        return "No controllers registered", 404
    return ",".join(controllers.keys()), 200


@app.route("/list_custom_devices", methods=["GET"])
def list_custom_devices():
    """
    List all available custom device files on disk.
    ---
    responses:
      200:
        description: Comma-separated list of device names
      404:
        description: No custom devices found
    """
    try:
        device_list = [
            d.split(".device")[0]
            for d in os.listdir("local/custom_devices/")
            if d.endswith(".device")
        ]
    except Exception:
        device_list = []

    if not device_list:
        return "No custom devices found, use the custom device creator cli to create a new device", 404

    return ",".join(device_list), 200


@app.route("/list_custom_device_commands", methods=["GET"])
def list_custom_device_commands():
    """
    List all commands for a registered custom device.
    ---
    parameters:
      - name: custom_device_name
        in: query
        type: string
        required: true
        description: Device name (without .device extension)
    responses:
      200:
        description: Comma-separated list of commands
      404:
        description: Device not registered
    """
    custom_device_name = f"{request.args.get('custom_device_name')}.device"

    if custom_device_name not in custom_devices:
        return f"custom device '{custom_device_name}' not found", 404

    device_commands = custom_devices[custom_device_name].get_commands()
    if device_commands:
        return ",".join(device_commands), 200

    return "No commands found", 200


@app.route("/register_custom_device", methods=["GET"])
def register_custom_device():
    """
    Register a custom device and associate it with a controller.
    ---
    parameters:
      - name: custom_device_name
        in: query
        type: string
        required: true
        description: Device name (without .device extension)
      - name: controller_name
        in: query
        type: string
        required: true
        description: Name of the registered controller to associate
    responses:
      200:
        description: Device registered successfully
      404:
        description: Device file or controller not found
    """
    custom_device_name = f"{request.args.get('custom_device_name')}.device"
    controller_name = request.args.get("controller_name")

    device_file = f"local/custom_devices/{custom_device_name}"
    if not os.path.exists(device_file):
        return f"custom device '{request.args.get('custom_device_name')}' not found", 404

    if controller_name not in controllers:
        return f"controller '{request.args.get('controller_name')}' not found", 404

    selected_controller = controllers[controller_name]
    custom_device = CustomDevice(selected_controller, device_file)
    custom_devices[custom_device_name] = custom_device
    _custom_device_registry[custom_device_name] = (custom_device, controller_name)
    save_config()

    return f"registered custom device '{request.args.get('custom_device_name')}' with controller '{controller_name}'", 200


def run_discovery(timeout, result_container):
    try:
        devices = broadlink.discover(timeout=timeout)
        result_container['devices'] = devices
        result_container['error'] = None
    except Exception as e:
        result_container['devices'] = []
        result_container['error'] = str(e)


@app.route("/discover_controllers", methods=["GET"])
def discover_controllers():
    """
    Discover all Broadlink devices on the local network via broadcast.
    ---
    parameters:
      - name: timeout
        in: query
        type: integer
        required: false
        description: "Discovery timeout in seconds (default: 5)"
      - name: auto_register
        in: query
        type: boolean
        required: false
        description: "If true, automatically register all discovered devices as controllers (default: false)"
    responses:
      200:
        description: List of discovered devices
      404:
        description: No devices found
      500:
        description: Discovery failed
    """
    timeout = int(request.args.get("timeout", 5))
    auto_register = request.args.get("auto_register", "false").lower() == "true"

    result = {}
    t = threading.Thread(target=run_discovery, args=(timeout, result))
    t.start()
    t.join(timeout + 2)

    if result.get('error'):
        return f"Discovery failed: {result['error']}", 500

    found = []
    for device in result.get('devices', []):
        if device.auth():
            entry = {
                "host": device.host[0],
                "mac": ''.join(format(x, '02x') for x in device.mac),
                "type": device.type,
                "devtype": hex(device.devtype)
            }

            if auto_register:
                name = f"{device.type}_{''.join(format(x, '02x') for x in device.mac)}"
                controller = BroadlinkController(local_ip=device.host[0], rf_frequency=DEFAULT_RF_FREQUENCY)
                controllers[name] = controller
                entry["registered_as"] = name

            found.append(entry)

    if auto_register and found:
        save_config()

    if not found:
        return "No devices found", 404

    return jsonify(found), 200


@app.route("/upload_custom_device", methods=["POST"])
def upload_custom_device():
    """
    Upload a new custom device file to the local/custom_devices directory.
    ---
    consumes:
      - multipart/form-data
    parameters:
      - name: file
        in: formData
        type: file
        required: true
        description: "The .device file to upload"
    responses:
      200:
        description: Device file uploaded successfully
      400:
        description: No file provided or invalid file type
      409:
        description: Device file already exists
    """
    if 'file' not in request.files:
        return "No file provided", 400

    file = request.files['file']

    if not file.filename or file.filename == '':
        return "No file selected", 400

    if not file.filename.endswith('.device'):
        return "Invalid file type, must be a .device file", 400

    filename = secure_filename(file.filename)
    dest_path = f"local/custom_devices/{filename}"

    if os.path.exists(dest_path):
        return f"Device file '{filename}' already exists, delete it first to replace", 409

    os.makedirs("local/custom_devices", exist_ok=True)
    file.save(dest_path)

    return f"Device file '{filename}' uploaded successfully", 200


if __name__ == '__main__':
    load_config()
    app.run(debug=True, host="0.0.0.0", port=5050)