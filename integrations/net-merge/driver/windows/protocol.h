#pragma once

#define NM_VERSION 1
#define NM_MAX_LINKS 16
#define NM_DEVICE_TYPE 0x8000
#define NM_IOCTL_CONFIG CTL_CODE(NM_DEVICE_TYPE, 0x800, METHOD_BUFFERED, FILE_WRITE_DATA)

// All fields are fixed-width; addresses are in network byte order. No pointers
// cross the user/kernel boundary. A single administrator controller owns a lease.
typedef struct _NM_LINK {
    UINT32 Family; // AF_INET (2) or AF_INET6 (23)
    UINT32 Weight; // 1..1000
    UINT8 Address[16];
} NM_LINK;

typedef struct _NM_CONFIG {
    UINT32 Version;
    UINT32 Count;
    UINT64 ProcessId; // explicit target process only; zero disables interception
    NM_LINK Links[NM_MAX_LINKS];
} NM_CONFIG;
