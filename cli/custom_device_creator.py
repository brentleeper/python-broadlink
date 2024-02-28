from lib.broadlink_controller import BroadlinkController
from lib.custom_device import CustomDeviceCreator


def get_value_as_float_or_none(value):
    try:
        return float(value)
    except:
        return None


def get_value_as_int_or_none(value):
    try:
        return int(value)
    except:
        return None


def get_value_as_ip_address_or_none(value):
    if is_ip_address(value):
        return value
    return None


def is_ip_address(value):
    parts = value.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not part.isdigit():
            return False
        if int(part) < 0 or int(part) > 255:
            return False
    return True


input("Follow prompts to create a new custom device. Press Enter to continue...")

rf_frequency = get_value_as_float_or_none(input("Enter RF Frequency as a float (ie: 422.32) if any: "))

if rf_frequency:
    print(f"will use rf frequency {rf_frequency} for training")
else:
    print("no rf frequency provided, frequency sweep will be used for rf training")

local_ip_address = get_value_as_ip_address_or_none(input("Enter local IP address of the broadlink device if any: "))

if local_ip_address:
    print(f"searching for broadlink device at {local_ip_address}")
else:
    print("no local ip address provided, a broadlink device search will be performed")

controller = BroadlinkController(local_ip=local_ip_address, rf_frequency=rf_frequency)

custom_device_name = None

modify_existing = input("Modify an existing device? (y/n) ").lower() == "y"

if modify_existing:
    custom_device_path = input("Enter the name of the custom device to modify: ")
    custom_device_creator = CustomDeviceCreator(controller, custom_device_path, modify_existing=True)
else:
    while not custom_device_name:
        custom_device_name = input("Enter a name for the custom device: ")
        if not custom_device_name:
            print("custom device name cannot be empty")

    custom_device_creator = CustomDeviceCreator(controller, custom_device_name)

done_creating = False

while not done_creating:
    command_name = input("Enter a command name to add to the custom device: ")
    if not command_name:
        print("command name cannot be empty")
        continue

    while True:
        selected_training_method = get_value_as_int_or_none(input("Train RF (1) or IR (2)?: "))
        if not selected_training_method or selected_training_method not in [1, 2]:
            print("invalid training method")
            continue
        break

    did_train = False

    if selected_training_method == 1:
        did_train = custom_device_creator.train_rf(command_name)
    else:
        did_train = custom_device_creator.train_ir(command_name)

    if did_train:
        test_command = input("Would you like to test the command? (y/n) ").lower() == "y"

        if test_command:
            custom_device_creator.test_command(command_name)

        testing_success = input("Was the command successful? (y/n) ").lower() == "y"

        if not testing_success:
            custom_device_creator.remove_command(command_name)
            print(f"command {command_name} removed from the custom device {custom_device_name}")
            print("command will need to be retrained")
        else:
            print(f"command {command_name} added to the custom device {custom_device_name}")

    done_creating = input("Done creating commands? (y/n) ").lower() == "y"

custom_device_creator.save("./")
