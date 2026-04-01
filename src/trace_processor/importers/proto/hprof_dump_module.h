/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_HPROF_DUMP_MODULE_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_HPROF_DUMP_MODULE_H_

#include <memory>

#include "protos/perfetto/trace/trace_packet.pbzero.h"
#include "src/trace_processor/importers/art_hprof/art_hprof_parser.h"
#include "src/trace_processor/importers/proto/proto_importer_module.h"

namespace perfetto::trace_processor {

class TraceProcessorContext;

// Handles TracePacket.hprof_dump: feeds raw .hprof binary data to
// ArtHprofParser, reusing the existing hprof parsing infrastructure.
class HprofDumpModule : public ProtoImporterModule {
 public:
  HprofDumpModule(ProtoImporterModuleContext* module_context,
                  TraceProcessorContext* context);
  ~HprofDumpModule() override;

  void ParseTracePacketData(const protos::pbzero::TracePacket::Decoder& decoder,
                            int64_t ts,
                            const TracePacketData& data,
                            uint32_t field_id) override;

 private:
  TraceProcessorContext* context_;
  std::unique_ptr<art_hprof::ArtHprofParser> parser_;
};

}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_HPROF_DUMP_MODULE_H_
