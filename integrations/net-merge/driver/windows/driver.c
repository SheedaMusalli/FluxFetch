// Experimental bind fast path. The controller must refresh its configuration
// every second. No routes or packet payloads are changed or copied by this driver.
#include <ntddk.h>
#include <wdmsec.h>
#include <initguid.h>
#include <fwpsk.h>
#include <fwpmk.h>
#include "protocol.h"

DEFINE_GUID(NM_DEVICE_GUID, 0x330a6261,0x713b,0x4bbb,0x99,0x18,0xf8,0x62,0x77,0x91,0x28,0x50);
DEFINE_GUID(NM_SUBLAYER, 0x330a6262,0x713b,0x4bbb,0x99,0x18,0xf8,0x62,0x77,0x91,0x28,0x50);
DEFINE_GUID(NM_CALLOUT4, 0x330a6263,0x713b,0x4bbb,0x99,0x18,0xf8,0x62,0x77,0x91,0x28,0x50);
DEFINE_GUID(NM_CALLOUT6, 0x330a6264,0x713b,0x4bbb,0x99,0x18,0xf8,0x62,0x77,0x91,0x28,0x50);

static PDEVICE_OBJECT Device;
static HANDLE Engine;
static UINT32 Callout4, Callout6;
static KSPIN_LOCK Lock;
static NM_CONFIG Config;
static UINT64 Expires;
static ULONG Sequence;
static UNICODE_STRING SymbolicName = RTL_CONSTANT_STRING(L"\\DosDevices\\FluxFetchNetMerge");

static VOID ClearConfig(VOID) {
    KIRQL irql;
    KeAcquireSpinLock(&Lock, &irql);
    RtlZeroMemory(&Config, sizeof(Config));
    Expires = 0;
    KeReleaseSpinLock(&Lock, irql);
}

static NTSTATUS Complete(PIRP irp, NTSTATUS status) {
    irp->IoStatus.Status = status;
    irp->IoStatus.Information = 0;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return status;
}

static NTSTATUS Dispatch(PDEVICE_OBJECT device, PIRP irp) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    NM_CONFIG *input;
    ULONG i;
    KIRQL irql;
    UNREFERENCED_PARAMETER(device);
    switch (stack->MajorFunction) {
    case IRP_MJ_CREATE: return Complete(irp, STATUS_SUCCESS);
    case IRP_MJ_CLEANUP:
    case IRP_MJ_CLOSE:
        ClearConfig();
        return Complete(irp, STATUS_SUCCESS);
    case IRP_MJ_DEVICE_CONTROL:
        if (stack->Parameters.DeviceIoControl.IoControlCode != NM_IOCTL_CONFIG)
            return Complete(irp, STATUS_INVALID_DEVICE_REQUEST);
        if (stack->Parameters.DeviceIoControl.InputBufferLength != sizeof(NM_CONFIG))
            return Complete(irp, STATUS_INVALID_BUFFER_SIZE);
        input = (NM_CONFIG *)irp->AssociatedIrp.SystemBuffer;
        if (!input || input->Version != NM_VERSION || input->Count > NM_MAX_LINKS ||
            (input->Count && input->ProcessId <= 4))
            return Complete(irp, STATUS_INVALID_PARAMETER);
        for (i = 0; i < input->Count; ++i) {
            NM_LINK *link = &input->Links[i];
            if ((link->Family != AF_INET && link->Family != AF_INET6) ||
                !link->Weight || link->Weight > 1000)
                return Complete(irp, STATUS_INVALID_PARAMETER);
            if (link->Family == AF_INET && (!link->Address[0] || link->Address[0] == 127 || link->Address[0] >= 224))
                return Complete(irp, STATUS_INVALID_PARAMETER);
            if (link->Family == AF_INET6 && (link->Address[0] == 0xff ||
                (link->Address[0] == 0xfe && (link->Address[1] & 0xc0) == 0x80)))
                return Complete(irp, STATUS_INVALID_PARAMETER);
        }
        KeAcquireSpinLock(&Lock, &irql);
        Config = *input;
        Expires = KeQueryInterruptTime() + 5ULL * 10000000ULL;
        KeReleaseSpinLock(&Lock, irql);
        return Complete(irp, STATUS_SUCCESS);
    default: return Complete(irp, STATUS_INVALID_DEVICE_REQUEST);
    }
}

static NTSTATUS Notify(FWPS_CALLOUT_NOTIFY_TYPE type, const GUID *key, FWPS_FILTER1 *filter) {
    UNREFERENCED_PARAMETER(type); UNREFERENCED_PARAMETER(key); UNREFERENCED_PARAMETER(filter);
    return STATUS_SUCCESS;
}

static VOID Classify(const FWPS_INCOMING_VALUES0 *values,
    const FWPS_INCOMING_METADATA_VALUES0 *metadata, VOID *layerData,
    const VOID *context, const FWPS_FILTER1 *filter, UINT64 flowContext,
    FWPS_CLASSIFY_OUT0 *output) {
    NM_LINK chosen = {0};
    ULONG family, total = 0, ticket, i;
    KIRQL irql;
    UINT64 handle = 0;
    FWPS_BIND_REQUEST0 *request = NULL;
    NTSTATUS status;
    UNREFERENCED_PARAMETER(layerData); UNREFERENCED_PARAMETER(flowContext);
    if (!(output->rights & FWPS_RIGHT_ACTION_WRITE)) return;
    output->actionType = FWP_ACTION_CONTINUE;
    if (!(metadata->currentMetadataValues & FWPS_METADATA_FIELD_PROCESS_ID)) return;
    family = values->layerId == FWPS_LAYER_ALE_BIND_REDIRECT_V4 ? AF_INET : AF_INET6;
    KeAcquireSpinLock(&Lock, &irql);
    if (Expires > KeQueryInterruptTime() && Config.ProcessId == metadata->processId) {
        for (i = 0; i < Config.Count; ++i)
            if (Config.Links[i].Family == family) total += Config.Links[i].Weight;
        if (total) {
            ticket = Sequence++ % total;
            for (i = 0; i < Config.Count; ++i) {
                if (Config.Links[i].Family != family) continue;
                if (ticket < Config.Links[i].Weight) { chosen = Config.Links[i]; break; }
                ticket -= Config.Links[i].Weight;
            }
        }
    }
    KeReleaseSpinLock(&Lock, irql);
    if (!chosen.Weight) return;
    status = FwpsAcquireClassifyHandle0((VOID *)context, 0, &handle);
    if (!NT_SUCCESS(status)) return;
    status = FwpsAcquireWritableLayerDataPointer0(handle, filter->filterId, 0, (VOID **)&request, output);
    if (NT_SUCCESS(status)) {
        // Respect explicit binds and earlier callouts. Only implicit wildcard,
        // ephemeral-port binds of the opted-in process can be changed.
        if (!request->previousVersion) {
            if (family == AF_INET) {
                SOCKADDR_IN *address = (SOCKADDR_IN *)&request->localAddressAndPort;
                if (address->sin_family == AF_INET && !address->sin_port && !address->sin_addr.S_un.S_addr)
                    RtlCopyMemory(&address->sin_addr, chosen.Address, 4);
            } else {
                SOCKADDR_IN6 *address = (SOCKADDR_IN6 *)&request->localAddressAndPort;
                IN6_ADDR zero = {0};
                if (address->sin6_family == AF_INET6 && !address->sin6_port &&
                    RtlCompareMemory(&address->sin6_addr, &zero, 16) == 16)
                    RtlCopyMemory(&address->sin6_addr, chosen.Address, 16);
            }
        }
        // WFP requires Apply even if writable data was left unchanged.
        FwpsApplyModifiedLayerData0(handle, request, 0);
        output->actionType = FWP_ACTION_PERMIT;
        output->rights &= ~FWPS_RIGHT_ACTION_WRITE;
    }
    FwpsReleaseClassifyHandle0(handle);
}

static NTSTATUS RegisterLayer(const GUID *key, const GUID *layer, UINT32 *id) {
    FWPS_CALLOUT1 runtime = {0};
    FWPM_CALLOUT0 management = {0};
    FWPM_FILTER0 filter = {0};
    NTSTATUS status;
    runtime.calloutKey = *key;
    runtime.classifyFn = Classify;
    runtime.notifyFn = Notify;
    status = FwpsCalloutRegister1(Device, &runtime, id);
    if (!NT_SUCCESS(status)) return status;
    management.calloutKey = *key;
    management.displayData.name = L"FluxFetch Net Merge bind fast path";
    management.applicableLayer = *layer;
    status = FwpmCalloutAdd0(Engine, &management, NULL, NULL);
    if (!NT_SUCCESS(status)) return status;
    filter.displayData.name = management.displayData.name;
    filter.layerKey = *layer;
    filter.subLayerKey = NM_SUBLAYER;
    filter.action.type = FWP_ACTION_CALLOUT_UNKNOWN;
    filter.action.calloutKey = *key;
    filter.weight.type = FWP_EMPTY;
    filter.flags = FWPM_FILTER_FLAG_PERMIT_IF_CALLOUT_UNREGISTERED;
    return FwpmFilterAdd0(Engine, &filter, NULL, NULL);
}

static VOID Unload(PDRIVER_OBJECT driver) {
    UNREFERENCED_PARAMETER(driver);
    ClearConfig();
    if (Engine) { FwpmEngineClose0(Engine); Engine = NULL; }
    if (Callout4) { FwpsCalloutUnregisterById0(Callout4); Callout4 = 0; }
    if (Callout6) { FwpsCalloutUnregisterById0(Callout6); Callout6 = 0; }
    IoDeleteSymbolicLink(&SymbolicName);
    if (Device) { IoDeleteDevice(Device); Device = NULL; }
}

DRIVER_INITIALIZE DriverEntry;
NTSTATUS DriverEntry(PDRIVER_OBJECT driver, PUNICODE_STRING registryPath) {
    UNICODE_STRING name = RTL_CONSTANT_STRING(L"\\Device\\FluxFetchNetMerge");
    UNICODE_STRING sddl = RTL_CONSTANT_STRING(L"D:P(A;;GA;;;SY)(A;;GA;;;BA)");
    FWPM_SESSION0 session = {0};
    FWPM_SUBLAYER0 sublayer = {0};
    NTSTATUS status;
    ULONG i;
    UNREFERENCED_PARAMETER(registryPath);
    KeInitializeSpinLock(&Lock);
    for (i = 0; i <= IRP_MJ_MAXIMUM_FUNCTION; ++i) driver->MajorFunction[i] = Dispatch;
    driver->DriverUnload = Unload;
    status = IoCreateDeviceSecure(driver, 0, &name, NM_DEVICE_TYPE,
        FILE_DEVICE_SECURE_OPEN, TRUE, &sddl, &NM_DEVICE_GUID, &Device);
    if (!NT_SUCCESS(status)) return status;
    status = IoCreateSymbolicLink(&SymbolicName, &name);
    if (!NT_SUCCESS(status)) goto failed;
    session.flags = FWPM_SESSION_FLAG_DYNAMIC;
    status = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, &session, &Engine);
    if (!NT_SUCCESS(status)) goto failed;
    status = FwpmTransactionBegin0(Engine, 0);
    if (!NT_SUCCESS(status)) goto failed;
    sublayer.subLayerKey = NM_SUBLAYER;
    sublayer.displayData.name = L"FluxFetch Net Merge";
    sublayer.weight = 0x100;
    status = FwpmSubLayerAdd0(Engine, &sublayer, NULL);
    if (NT_SUCCESS(status)) status = RegisterLayer(&NM_CALLOUT4, &FWPM_LAYER_ALE_BIND_REDIRECT_V4, &Callout4);
    if (NT_SUCCESS(status)) status = RegisterLayer(&NM_CALLOUT6, &FWPM_LAYER_ALE_BIND_REDIRECT_V6, &Callout6);
    if (!NT_SUCCESS(status)) { FwpmTransactionAbort0(Engine); goto failed; }
    status = FwpmTransactionCommit0(Engine);
    if (!NT_SUCCESS(status)) goto failed;
    Device->Flags &= ~DO_DEVICE_INITIALIZING;
    return STATUS_SUCCESS;
failed:
    Unload(driver);
    return status;
}
