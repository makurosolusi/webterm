// Wizard step 3, Commands (optional): what webterm found on this machine and the folders to add. Nothing
// is saved by Continue (every change in the panel applies on its own), so Skip and Continue only differ
// in the answer they record.
import { CustomCommandsPanel } from '../customCommands/CustomCommandsPanel'
import { SETUP_TEXT } from './setup.labels'
import { StepFooter, StepPage, type StepProps, type StepSetting } from './setup.ui'

const SETTING: StepSetting = { where: SETUP_TEXT.commands.where, section: 'canvas', field: 'custom-commands' }

export function CommandsStep({ nav }: StepProps): React.JSX.Element {
  return (
    <StepPage step="commands" setting={SETTING} footer={<StepFooter nav={nav} />}>
      <CustomCommandsPanel />
    </StepPage>
  )
}
