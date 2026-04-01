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

#include "src/trace_processor/importers/proto/hprof_dump_module.h"

#include <cstring>
#include <memory>

#include "perfetto/base/logging.h"
#include "perfetto/trace_processor/trace_blob_view.h"
#include "protos/perfetto/trace/profiling/hprof_dump.pbzero.h"
#include "protos/perfetto/trace/trace_packet.pbzero.h"
#include "src/trace_processor/importers/common/parser_types.h"
#include "src/trace_processor/types/trace_processor_context.h"

namespace perfetto::trace_processor {

using protos::pbzero::TracePacket;

HprofDumpModule::~HprofDumpModule() = default;

HprofDumpModule::HprofDumpModule(ProtoImporterModuleContext* module_context,
                                 TraceProcessorContext* context)
    : ProtoImporterModule(module_context), context_(context) {
  RegisterForField(TracePacket::kHprofDumpFieldNumber);
}

void HprofDumpModule::ParseTracePacketData(const TracePacket::Decoder& decoder,
                                           int64_t,
                                           const TracePacketData&,
                                           uint32_t field_id) {
  if (field_id != TracePacket::kHprofDumpFieldNumber) {
    return;
  }

  protos::pbzero::HprofDump::Decoder dump(decoder.hprof_dump());
  if (!dump.has_hprof_data()) {
    return;
  }

  auto data = dump.hprof_data();
  if (data.size == 0) {
    return;
  }

  // Lazily create the parser on first chunk.
  if (!parser_) {
    parser_ = std::make_unique<art_hprof::ArtHprofParser>(context_);
  }

  // Copy bytes and feed to the parser. ArtHprofParser accumulates chunks
  // internally and parses when it has enough data.
  auto blob = TraceBlob::Allocate(data.size);
  memcpy(blob.data(), data.data, data.size);
  base::Status status =
      parser_->Parse(TraceBlobView(std::move(blob), 0, data.size));
  if (!status.ok()) {
    PERFETTO_ELOG("Failed to parse hprof chunk: %s", status.c_message());
  }
}

}  // namespace perfetto::trace_processor
