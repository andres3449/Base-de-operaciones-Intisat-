cmake_minimum_required(VERSION 3.15)
project(intisat_sdr C)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)

# ── Opciones de compilacion ───────────────────────────────
option(BUILD_WITH_RTLSDR "Compilar con soporte RTL-SDR hardware" ON)
option(BUILD_WITH_LIMESDR "Compilar con soporte LimeSDR hardware" ON)

# ── Flags de compilacion por plataforma ───────────────────
if(WIN32)
    add_definitions(-D_WIN32 -DWIN32_LEAN_AND_MEAN)
    if(MSVC)
        # /std:c17 + /experimental:c11atomics habilita <stdatomic.h> en MSVC
        add_compile_options(/W3 /experimental:c11atomics)
    else()
        # MinGW
        add_compile_options(-Wall -O2)
    endif()
else()
    add_compile_options(-Wall -Wextra -O2)
    find_package(Threads REQUIRED)
endif()

# ── Third-party: kiss_fft (dominio publico, embebido) ─────
add_library(kiss_fft STATIC
    third_party/kiss_fft/kiss_fft.c
)
target_include_directories(kiss_fft PUBLIC third_party/kiss_fft)

# ── Third-party: cJSON (MIT, embebido) ────────────────────
add_library(cjson STATIC
    third_party/cJSON/cJSON.c
)
target_include_directories(cjson PUBLIC third_party/cJSON)

# ── Buscar librtlsdr ─────────────────────────────────────
if(BUILD_WITH_RTLSDR)
    # Headers y .lib estan en third_party/rtlsdr (descargados)
    # El .dll esta en la raiz del proyecto
    find_path(RTLSDR_INCLUDE_DIR rtl-sdr.h
        PATHS
            ${CMAKE_SOURCE_DIR}/third_party/rtlsdr
            ${CMAKE_SOURCE_DIR}/../
            /usr/include
            /usr/local/include
            $ENV{RTLSDR_DIR}/include
    )
    find_library(RTLSDR_LIBRARY
        NAMES rtlsdr librtlsdr
        PATHS
            ${CMAKE_SOURCE_DIR}/third_party/rtlsdr
            ${CMAKE_SOURCE_DIR}/../
            /usr/lib
            /usr/local/lib
            $ENV{RTLSDR_DIR}/lib
    )

    if(RTLSDR_INCLUDE_DIR AND RTLSDR_LIBRARY)
        message(STATUS "librtlsdr encontrado: ${RTLSDR_LIBRARY}")
        message(STATUS "  include: ${RTLSDR_INCLUDE_DIR}")
        add_definitions(-DHAS_RTLSDR)
    else()
        message(WARNING "librtlsdr NO encontrado. Compilando sin soporte hardware RTL-SDR.")
        message(WARNING "  Para habilitarlo, setea -DRTLSDR_DIR=<ruta>")
        set(BUILD_WITH_RTLSDR OFF)
    endif()
endif()

# ── Buscar LimeSuite ─────────────────────────────────────
if(BUILD_WITH_LIMESDR)
    find_path(LIMESDR_INCLUDE_DIR lime/LimeSuite.h
        PATHS
            "C:/Program Files/PothosSDR/include"
            ${CMAKE_SOURCE_DIR}/third_party/limesdr
            /usr/include
            /usr/local/include
            $ENV{LIMESDR_DIR}/include
    )
    find_library(LIMESDR_LIBRARY
        NAMES LimeSuite
        PATHS
            "C:/Program Files/PothosSDR/lib"
            ${CMAKE_SOURCE_DIR}/third_party/limesdr
            /usr/lib
            /usr/local/lib
            $ENV{LIMESDR_DIR}/lib
    )

    if(LIMESDR_INCLUDE_DIR AND LIMESDR_LIBRARY)
        message(STATUS "LimeSuite encontrado: ${LIMESDR_LIBRARY}")
        message(STATUS "  include: ${LIMESDR_INCLUDE_DIR}")
        add_definitions(-DHAS_LIMESDR)
    else()
        message(WARNING "LimeSuite NO encontrado. Compilando sin soporte hardware LimeSDR.")
        message(WARNING "  Para habilitarlo, instala PothosSDR o setea -DLIMESDR_DIR=<ruta>")
        set(BUILD_WITH_LIMESDR OFF)
    endif()
endif()

# ── Buscar libzmq ─────────────────────────────────────────
# Intentar primero con find_package (funciona con vcpkg toolchain)
find_package(ZeroMQ CONFIG QUIET)
if(ZeroMQ_FOUND)
    message(STATUS "libzmq encontrado via find_package (vcpkg)")
    set(ZMQ_TARGET libzmq)
else()
    # Fallback: buscar manualmente
    find_path(ZMQ_INCLUDE_DIR zmq.h
        PATHS /usr/include /usr/local/include $ENV{ZMQ_DIR}/include
    )
    find_library(ZMQ_LIBRARY
        NAMES zmq libzmq
        PATHS /usr/lib /usr/local/lib $ENV{ZMQ_DIR}/lib
    )
    if(NOT ZMQ_INCLUDE_DIR OR NOT ZMQ_LIBRARY)
        message(FATAL_ERROR
            "libzmq NO encontrado.\n"
            "  Windows: vcpkg install zeromq:x64-windows\n"
            "  Linux:   sudo apt install libzmq3-dev")
    endif()
    message(STATUS "libzmq encontrado: ${ZMQ_LIBRARY}")
    set(ZMQ_TARGET "")
endif()

# ── Fuentes del ejecutable ────────────────────────────────
set(SOURCES
    src/main.c
    src/platform.c
    src/ring_buffer.c
    src/nco.c
    src/fir_filter.c
    src/fm_demod.c
    src/clock_recovery.c
    src/sync_detect.c
    src/packet_extract.c
    src/burst_detect.c
    src/pn_dewhiten.c
    src/fft_engine.c
    src/dsp_pipeline.c
    src/zmq_transport.c
    src/rtlsdr_reader.c
    src/limesdr_reader.c
    src/limesdr_tx.c
)

add_executable(intisat_sdr ${SOURCES})

target_include_directories(intisat_sdr PRIVATE include)

# Link ZMQ: via target (vcpkg) o via manual path
if(ZMQ_TARGET)
    target_link_libraries(intisat_sdr PRIVATE kiss_fft cjson ${ZMQ_TARGET})
else()
    target_include_directories(intisat_sdr PRIVATE ${ZMQ_INCLUDE_DIR})
    target_link_libraries(intisat_sdr PRIVATE kiss_fft cjson ${ZMQ_LIBRARY})
endif()

# ── Link de librtlsdr (si disponible) ─────────────────────
if(BUILD_WITH_RTLSDR)
    target_include_directories(intisat_sdr PRIVATE ${RTLSDR_INCLUDE_DIR})
    target_link_libraries(intisat_sdr PRIVATE ${RTLSDR_LIBRARY})
endif()

# ── Link de LimeSuite (si disponible) ─────────────────────
if(BUILD_WITH_LIMESDR)
    target_include_directories(intisat_sdr PRIVATE ${LIMESDR_INCLUDE_DIR})
    target_link_libraries(intisat_sdr PRIVATE ${LIMESDR_LIBRARY})
endif()

# ── Link de math y threads por plataforma ─────────────────
if(WIN32)
    # Windows: math esta incluida, threads via Win32 API
    # winmm: para timeBeginPeriod/timeEndPeriod (timer 1ms resolution)
    target_link_libraries(intisat_sdr PRIVATE ws2_32 winmm)
    if(NOT MSVC)
        target_link_libraries(intisat_sdr PRIVATE m)
    endif()
else()
    # Linux/macOS: necesita libm y pthreads
    target_link_libraries(intisat_sdr PRIVATE m Threads::Threads)
endif()

# ── Output: poner el .exe en build/ para que Python lo encuentre ──
set_target_properties(intisat_sdr PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)

# ── Instalacion ───────────────────────────────────────────
install(TARGETS intisat_sdr DESTINATION bin)

# ── Resumen ───────────────────────────────────────────────
message(STATUS "")
message(STATUS "=== IntiSat SDR Backend ===")
message(STATUS "  RTL-SDR:   ${BUILD_WITH_RTLSDR}")
message(STATUS "  LimeSDR:   ${BUILD_WITH_LIMESDR}")
message(STATUS "  ZMQ:       ${ZMQ_LIBRARY}")
message(STATUS "  Compiler:  ${CMAKE_C_COMPILER_ID}")
message(STATUS "  Platform:  ${CMAKE_SYSTEM_NAME}")
message(STATUS "===========================")
